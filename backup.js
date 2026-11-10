// Secondary, append-only backup to a Google Sheet.
//
// Every successful change made in the dashboard (member added / edited / deleted, fees received,
// attendance changed) is sent as a new row to a Google Apps Script web app attached to a Google
// Sheet (see google-apps-script/Code.gs). Rows are only ever appended, never edited or removed,
// so the sheet is a full history even if the server or database fails.
//
// Sending happens in the background with retries, so a slow or unavailable Google Sheet never
// slows down or breaks the dashboard.
//
// Env: SHEETS_WEBHOOK_URL (the Apps Script /exec URL) and SHEETS_WEBHOOK_SECRET.
const crypto = require('crypto');
const db = require('./db');

const WEBHOOK_URL = (process.env.SHEETS_WEBHOOK_URL || '').trim();
const WEBHOOK_SECRET = (process.env.SHEETS_WEBHOOK_SECRET || '').trim();
const TIME_ZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const BATCH_SIZE = 50;
const MAX_QUEUE = 20000;
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 10 * 60_000;

const localFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

const enabled = () => Boolean(WEBHOOK_URL && WEBHOOK_SECRET);

const queue = [];
let sending = false;
let retryDelay = MIN_RETRY_MS;
let retryTimer = null;

function toDateStr(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// Queue one event for the sheet.
function record(event, member = {}, extra = {}) {
  if (!enabled()) return;
  const now = new Date();
  queue.push({
    id: crypto.randomUUID(),
    at: now.toISOString(),
    at_local: localFmt.format(now),
    event,
    member_id: member.id ?? '',
    card_no: member.card_no ?? '',
    name: member.name ?? '',
    mobile: member.mobile ?? '',
    age: member.age ?? '',
    join_date: toDateStr(member.join_date),
    attendance: member.attending === undefined ? '' : member.attending ? 'Coming' : 'Not coming',
    fee_month: extra.fee_month ?? '',
    fee_status: extra.fee_status ?? '',
    paid_on: toDateStr(extra.paid_on),
    details: extra.details ?? '',
  });
  if (queue.length > MAX_QUEUE) {
    const dropped = queue.splice(0, queue.length - MAX_QUEUE);
    console.error(`[backup] queue full, dropped ${dropped.length} oldest events`);
  }
  setImmediate(flush);
}

async function flush() {
  if (sending || !queue.length || !enabled()) return;
  sending = true;
  const batch = queue.slice(0, BATCH_SIZE);
  let ok = false;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: WEBHOOK_SECRET, events: batch }),
      redirect: 'follow', // Apps Script answers via a redirect
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`unexpected response (HTTP ${res.status}): ${text.slice(0, 120)}`);
    }
    if (!data.ok) throw new Error(data.error || 'sheet rejected the events');
    queue.splice(0, batch.length);
    retryDelay = MIN_RETRY_MS;
    ok = true;
  } catch (err) {
    console.error(`[backup] could not write to Google Sheet (${queue.length} waiting), retrying in ${Math.round(retryDelay / 1000)}s:`, err.message);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(flush, retryDelay);
    retryTimer.unref?.();
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  } finally {
    sending = false;
  }
  if (ok && queue.length) setImmediate(flush);
}

// Wait until everything queued has been written (used by the full-backup script).
async function flushAll(timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (queue.length && Date.now() < end) {
    await flush();
    if (queue.length) await new Promise((r) => setTimeout(r, sending ? 200 : Math.min(retryDelay, 2000)));
  }
  return queue.length === 0;
}

// Watches successful member API calls and records them. Mount BEFORE the member routes.
function mount(app) {
  if (!enabled()) {
    console.warn('[backup] SHEETS_WEBHOOK_URL / SHEETS_WEBHOOK_SECRET not set — Google Sheet backup is off.');
    return;
  }
  console.log('[backup] Google Sheet backup is on.');

  app.use('/api/members', async (req, res, next) => {
    if (req.method === 'GET') return next();
    const parts = req.path.split('/').filter(Boolean); // [], [id], [id, 'payments'], [id, 'attendance']

    // A deleted member's details must be read before the delete happens.
    let before = null;
    if (req.method === 'DELETE' && parts.length === 1 && req.cookies?.rg_session) {
      try {
        const { rows } = await db.query(
          'SELECT id, name, age, mobile, card_no, join_date, attending FROM members WHERE id = $1',
          [Number(parts[0]) || 0]
        );
        before = rows[0] || null;
      } catch {
        before = null;
      }
    }

    const json = res.json.bind(res);
    res.json = (body) => {
      res.locals.backupBody = body;
      return json(body);
    };

    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const body = res.locals.backupBody || {};
      try {
        if (req.method === 'POST' && parts.length === 0) {
          record('MEMBER_ADDED', body);
        } else if (req.method === 'PUT' && parts.length === 1) {
          record('MEMBER_UPDATED', body);
        } else if (req.method === 'POST' && parts[1] === 'payments' && res.statusCode === 201) {
          record('FEE_RECEIVED', body, { fee_month: req.body?.month, fee_status: 'Paid', paid_on: body.fee_paid_on });
        } else if (req.method === 'PATCH' && parts[1] === 'attendance') {
          record('ATTENDANCE_CHANGED', body);
        } else if (req.method === 'DELETE' && parts.length === 1) {
          record('MEMBER_DELETED', before || { id: Number(parts[0]) }, { details: 'Member and fee history deleted in the app' });
        }
      } catch (err) {
        console.error('[backup] could not queue event:', err.message);
      }
    });
    next();
  });
}

module.exports = { mount, record, flushAll, enabled, pending: () => queue.length };
