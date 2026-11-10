require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const argon2 = require('argon2');
const db = require('./db');
const report = require('./report');

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@royalsgym.in').trim().toLowerCase();
// Tolerate values pasted with surrounding quotes/spaces (e.g. copied from .env into a hosting dashboard).
const ADMIN_PASSWORD_HASH = (process.env.ADMIN_PASSWORD_HASH || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = 'rg_session';
const SESSION_HOURS = 12;

if (!ADMIN_PASSWORD_HASH) {
  console.error('ADMIN_PASSWORD_HASH is not set. Add it to the environment (value starts with $argon2id$).');
  process.exit(1);
}
if (!/^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(ADMIN_PASSWORD_HASH)) {
  console.error(
    `ADMIN_PASSWORD_HASH is set but is not a valid Argon2id hash (length ${ADMIN_PASSWORD_HASH.length}, ` +
      `starts with "${ADMIN_PASSWORD_HASH.slice(0, 10)}"). It must start with $argon2id$ and be copied in full. ` +
      'Generate one with: npm run hash-password -- "YourPassword"'
  );
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be set to a random string of at least 32 characters.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Render / Netlify sit behind a proxy
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

// ---------- Auth helpers ----------
function readSession(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  req.admin = session;
  next();
}

// CSRF defence: session cookie is SameSite=Strict, and every state-changing
// request must be JSON from our own origin.
function sameOriginJson(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = ''; }
    if (host !== req.get('host')) return res.status(403).json({ error: 'Bad origin' });
  }
  if (req.method !== 'DELETE' && !req.is('application/json')) {
    return res.status(415).json({ error: 'JSON required' });
  }
  next();
}
app.use('/api', sameOriginJson);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

// ---------- Auth routes ----------
app.post('/api/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password || password.length > 200) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  // Always run the hash check so response time does not reveal whether the email matched.
  let passwordOk = false;
  try {
    passwordOk = await argon2.verify(ADMIN_PASSWORD_HASH, password);
  } catch {
    passwordOk = false;
  }
  const emailOk =
    email.length === ADMIN_EMAIL.length &&
    crypto.timingSafeEqual(Buffer.from(email), Buffer.from(ADMIN_EMAIL));

  if (!(passwordOk && emailOk)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = jwt.sign({ sub: ADMIN_EMAIL, role: 'admin' }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${SESSION_HOURS}h`,
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
    path: '/',
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: IS_PROD, sameSite: 'strict', path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ email: req.admin.sub });
});

// ---------- Calendar (gym's local time zone) ----------
const TIME_ZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function today() {
  return dateFmt.format(new Date()); // YYYY-MM-DD
}
function currentMonth() {
  return today().slice(0, 7); // YYYY-MM
}

// First month fees are tracked from. Earlier months can't be viewed or marked.
const FEES_START_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/.test(process.env.FEES_START_MONTH || '')
  ? process.env.FEES_START_MONTH
  : '2026-01';

function monthIndex(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + (m - 1);
}

// First month a member owes fees for: the later of the tracking start and their joining month.
function firstFeeMonth(joinDate) {
  const joinMonth = joinDate.slice(0, 7);
  return joinMonth > FEES_START_MONTH ? joinMonth : FEES_START_MONTH;
}

// ---------- Member validation ----------
const CARD_RE = /^[A-Z0-9][A-Z0-9-]{0,19}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function validateMember(body) {
  const errors = [];
  const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
  const age = Number(body?.age);
  const cardNo = String(body?.card_no ?? '').trim().toUpperCase();
  const joinDate = String(body?.join_date ?? '').trim();
  const attending = body?.attending !== false;
  // Indian mobile: accept "+91 98765-43210", "098765 43210", etc. Store the 10 digits.
  const mobile = String(body?.mobile ?? '')
    .replace(/[\s()-]/g, '')
    .replace(/^(\+?91|0)(?=\d{10}$)/, '');

  if (!name || name.length > 100) errors.push('Name is required (max 100 characters).');
  if (!Number.isInteger(age) || age < 5 || age > 100) errors.push('Age must be a whole number between 5 and 100.');
  if (!/^[6-9]\d{9}$/.test(mobile)) errors.push('Mobile number must be a valid 10-digit Indian number.');
  if (!CARD_RE.test(cardNo)) errors.push('Membership card number must be letters, numbers or "-" (e.g. E-123).');
  if (!DATE_RE.test(joinDate) || Number.isNaN(Date.parse(joinDate))) errors.push('Date of joining is invalid.');
  else if (joinDate > today()) errors.push('Date of joining cannot be in the future.');

  return { errors, data: { name, age, mobile, cardNo, joinDate, attending } };
}

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  return id;
}

function isUniqueViolation(err) {
  return err?.code === '23505' || /unique|duplicate/i.test(err?.message || '');
}

function toDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function mapRow(r) {
  const feePaidOn = toDateStr(r.fee_paid_on);
  return {
    id: r.id,
    name: r.name,
    age: r.age,
    mobile: r.mobile || '',
    card_no: r.card_no,
    join_date: toDateStr(r.join_date),
    attending: r.attending,
    fee_paid: Boolean(feePaidOn), // paid for the requested month?
    fee_paid_on: feePaidOn,
  };
}

const MEMBER_SELECT = `
  SELECT m.id, m.name, m.age, m.mobile, m.card_no, m.join_date, m.attending, p.paid_on AS fee_paid_on
  FROM members m
  LEFT JOIN fee_payments p ON p.member_id = m.id AND p.month = $1`;

// Month from ?month=YYYY-MM, defaulting to the current calendar month.
// Months before FEES_START_MONTH and future months are rejected.
function monthParam(req, res) {
  const cur = currentMonth();
  const month = req.query.month ? String(req.query.month) : cur;
  if (!MONTH_RE.test(month) || month > cur || month < FEES_START_MONTH) {
    res.status(400).json({ error: 'Invalid month' });
    return null;
  }
  return month;
}

// Adds `dues`: number of unpaid months from firstFeeMonth up to the current month.
async function withDues(members) {
  if (!members.length) return members;
  const cur = currentMonth();
  const { rows } = await db.query(
    'SELECT member_id, month FROM fee_payments WHERE month >= $1 AND month <= $2',
    [FEES_START_MONTH, cur]
  );
  const paid = new Map(); // member_id -> [months]
  for (const r of rows) {
    const id = Number(r.member_id);
    if (!paid.has(id)) paid.set(id, []);
    paid.get(id).push(r.month);
  }
  return members.map((m) => {
    const from = firstFeeMonth(m.join_date);
    const owed = Math.max(0, monthIndex(cur) - monthIndex(from) + 1);
    const paidCount = (paid.get(m.id) || []).filter((mo) => mo >= from).length;
    return { ...m, dues: Math.max(0, owed - paidCount) };
  });
}

async function memberView(id, month) {
  const { rows } = await db.query(`${MEMBER_SELECT} WHERE m.id = $2`, [month, id]);
  return rows[0] ? (await withDues([mapRow(rows[0])]))[0] : null;
}

// ---------- Member routes ----------
// List members for a month (members who had joined by then), with that month's fee status.
app.get('/api/members', requireAuth, async (req, res) => {
  const month = monthParam(req, res);
  if (!month) return;
  const { rows } = await db.query(`${MEMBER_SELECT} ORDER BY m.id DESC`, [month]);
  const members = await withDues(rows.map(mapRow).filter((m) => m.join_date.slice(0, 7) <= month));
  res.json({ month, currentMonth: currentMonth(), today: today(), feesStartMonth: FEES_START_MONTH, members });
});

// Full fee history of one member, from their first fee month to now.
app.get('/api/members/:id/payments', requireAuth, async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const member = await memberView(id, currentMonth());
  if (!member) return res.status(404).json({ error: 'Member not found' });
  const { rows } = await db.query(
    'SELECT month, paid_on FROM fee_payments WHERE member_id = $1 AND month >= $2 ORDER BY month',
    [id, FEES_START_MONTH]
  );
  res.json({
    member,
    firstMonth: firstFeeMonth(member.join_date),
    currentMonth: currentMonth(),
    today: today(),
    payments: rows.map((r) => ({ month: r.month, paid_on: toDateStr(r.paid_on) })),
  });
});

app.post('/api/members', requireAuth, async (req, res) => {
  const { errors, data } = validateMember(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  try {
    const { rows } = await db.query(
      `INSERT INTO members (name, age, mobile, card_no, join_date, attending)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [data.name, data.age, data.mobile, data.cardNo, data.joinDate, data.attending]
    );
    res.status(201).json(await memberView(rows[0].id, currentMonth()));
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: `Card number ${data.cardNo} already exists.` });
    throw err;
  }
});

app.put('/api/members/:id', requireAuth, async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const month = monthParam(req, res);
  if (!month) return;
  const { errors, data } = validateMember(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  try {
    const { rowCount } = await db.query(
      `UPDATE members SET name = $1, age = $2, mobile = $3, card_no = $4, join_date = $5, attending = $6,
         updated_at = NOW()
       WHERE id = $7`,
      [data.name, data.age, data.mobile, data.cardNo, data.joinDate, data.attending, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Member not found' });
    res.json(await memberView(id, month));
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: `Card number ${data.cardNo} already exists.` });
    throw err;
  }
});

// Mark a month's fees as received. There is deliberately no endpoint to undo this.
app.post('/api/members/:id/payments', requireAuth, async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const month = String(req.body?.month || '');
  if (!MONTH_RE.test(month) || month > currentMonth()) {
    return res.status(400).json({ error: 'Invalid month' });
  }
  if (month < FEES_START_MONTH) {
    return res.status(400).json({ error: 'Fees are only recorded from the start month onwards.' });
  }
  // The admin must type "received" — guards against accidental clicks.
  if (String(req.body?.confirm || '').trim().toLowerCase() !== 'received') {
    return res.status(400).json({ error: 'Type RECEIVED to confirm the fees were received.' });
  }
  const member = await memberView(id, month);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  if (month < member.join_date.slice(0, 7)) {
    return res.status(400).json({ error: 'That month is before the member joined.' });
  }
  // Date the money was actually received (defaults to today; needed when entering past months).
  const paidOn = req.body?.paid_on ? String(req.body.paid_on) : today();
  if (!DATE_RE.test(paidOn) || Number.isNaN(Date.parse(paidOn)) || paidOn > today()) {
    return res.status(400).json({ error: 'Date received is invalid or in the future.' });
  }
  if (paidOn < member.join_date) {
    return res.status(400).json({ error: 'Date received cannot be before the member joined.' });
  }
  if (member.fee_paid) return res.json(member); // already paid — stays paid
  try {
    await db.query('INSERT INTO fee_payments (member_id, month, paid_on) VALUES ($1, $2, $3)', [id, month, paidOn]);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err; // a concurrent request already recorded it
  }
  res.status(201).json(await memberView(id, month));
});

app.patch('/api/members/:id/attendance', requireAuth, async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const month = monthParam(req, res);
  if (!month) return;
  if (typeof req.body?.attending !== 'boolean') return res.status(400).json({ error: 'attending must be true or false' });
  const { rowCount } = await db.query('UPDATE members SET attending = $1, updated_at = NOW() WHERE id = $2', [
    req.body.attending,
    id,
  ]);
  if (!rowCount) return res.status(404).json({ error: 'Member not found' });
  res.json(await memberView(id, month));
});

app.delete('/api/members/:id', requireAuth, async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  await db.query('DELETE FROM fee_payments WHERE member_id = $1', [id]);
  const { rowCount } = await db.query('DELETE FROM members WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Member not found' });
  res.json({ ok: true });
});

report.mount(app, requireAuth); // monthly fees report PDF download (see report.js)

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Pages ----------
const PUBLIC = path.join(__dirname, 'public');

app.get('/', (req, res) => {
  if (readSession(req)) return res.redirect('/dashboard');
  res.sendFile(path.join(PUBLIC, 'login.html'));
});

app.get('/dashboard', (req, res) => {
  if (!readSession(req)) return res.redirect('/');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC, 'dashboard.html'));
});

app.get('/healthz', (req, res) => res.send('ok'));

app.use(express.static(PUBLIC, { index: false, maxAge: IS_PROD ? '1h' : 0 }));

// ---------- Errors ----------
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`Royals Gym running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
