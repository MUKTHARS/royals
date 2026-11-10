/**
 * Royals Gym — append-only backup sheet.
 *
 * Paste this into Extensions → Apps Script of the backup Google Sheet, run `setup` once,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * The app sends every change here; rows are only ever ADDED, never changed or removed.
 */
const SHEET_NAME = 'Log';
const HEADERS = [
  'Logged at (IST)', 'Event', 'Member ID', 'Card no', 'Name', 'Mobile', 'Age',
  'Date of joining', 'Attendance', 'Fee month', 'Fee status', 'Date received',
  'Details', 'Event ID', 'Server time (UTC)',
];

/** Run once from the Apps Script editor. Creates the Log tab, locks it, and prints the secret. */
function setup() {
  const sheet = getLogSheet_();

  // Lock the tab: only the sheet owner (and this script, which runs as the owner) can edit.
  const existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  const protection = existing.length ? existing[0] : sheet.protect();
  protection.setDescription('Royals Gym backup — append only. Do not edit.');
  protection.removeEditors(protection.getEditors());
  if (protection.canDomainEdit()) protection.setDomainEdit(false);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) {
    props.setProperty('SECRET', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }
  Logger.log('SHEETS_WEBHOOK_SECRET = ' + props.getProperty('SECRET'));
}

function getLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME, 0);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#14161c').setFontColor('#d4a63a');
    sheet.setColumnWidth(1, 170);
    sheet.setColumnWidth(5, 180);
    sheet.setColumnWidth(13, 260);
  }
  return sheet;
}

// Store everything as plain text; stop values like "=..." from running as formulas.
function cell_(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return json_({ ok: false, error: 'POST only' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad request' });
  }
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || body.secret !== secret) return json_({ ok: false, error: 'unauthorized' });

  const events = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getLogSheet_();
    const cache = CacheService.getScriptCache();
    const rows = [];
    const seen = {};
    for (const ev of events) {
      if (!ev || !ev.id || seen[ev.id] || cache.get('ev_' + ev.id)) continue; // skip retried duplicates
      seen[ev.id] = true;
      rows.push([
        ev.at_local, ev.event, ev.member_id, ev.card_no, ev.name, ev.mobile, ev.age,
        ev.join_date, ev.attendance, ev.fee_month, ev.fee_status, ev.paid_on,
        ev.details, ev.id, ev.at,
      ].map(cell_));
    }
    if (rows.length) {
      const range = sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length);
      range.setNumberFormat('@').setValues(rows);
      Object.keys(seen).forEach((id) => cache.put('ev_' + id, '1', 21600));
    }
    return json_({ ok: true, added: rows.length });
  } finally {
    lock.releaseLock();
  }
}
