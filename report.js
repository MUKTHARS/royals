// Monthly fees report as a downloadable PDF.
//   GET /api/reports/fees.pdf?month=YYYY-MM   (admin login required; defaults to the current month)
const PDFDocument = require('pdfkit');
const db = require('./db');

const TIME_ZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const FEES_START_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/.test(process.env.FEES_START_MONTH || '')
  ? process.env.FEES_START_MONTH
  : '2026-01';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true });
const today = () => dateFmt.format(new Date()); // YYYY-MM-DD

// ---------- Helpers ----------
function toDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function monthIndex(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + (m - 1);
}
function fmtMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function fmtMobile(n) {
  return /^\d{10}$/.test(n || '') ? `${n.slice(0, 5)} ${n.slice(5)}` : n || '';
}

// ---------- Data ----------
async function buildReport(month) {
  const { rows: memberRows } = await db.query('SELECT id, name, age, mobile, card_no, join_date, attending FROM members');
  const { rows: payRows } = await db.query(
    'SELECT member_id, month, paid_on FROM fee_payments WHERE month >= $1 AND month <= $2',
    [FEES_START_MONTH, month]
  );

  const paidByMember = new Map(); // id -> Map(month -> paid_on)
  for (const p of payRows) {
    const id = Number(p.member_id);
    if (!paidByMember.has(id)) paidByMember.set(id, new Map());
    paidByMember.get(id).set(p.month, toDateStr(p.paid_on));
  }

  const members = memberRows
    .map((r) => ({ ...r, id: Number(r.id), join_date: toDateStr(r.join_date) }))
    .filter((m) => m.join_date.slice(0, 7) <= month) // only members who had joined by this month
    .map((m) => {
      const paid = paidByMember.get(m.id) || new Map();
      const joinMonth = m.join_date.slice(0, 7);
      const from = joinMonth > FEES_START_MONTH ? joinMonth : FEES_START_MONTH;
      const owed = Math.max(0, monthIndex(month) - monthIndex(from) + 1);
      const paidCount = [...paid.keys()].filter((mo) => mo >= from && mo <= month).length;
      return { ...m, paid: paid.has(month), paid_on: paid.get(month) || null, dues: Math.max(0, owed - paidCount) };
    })
    .sort((a, b) => a.card_no.localeCompare(b.card_no, 'en', { numeric: true }));

  return {
    month,
    members,
    paid: members.filter((m) => m.paid),
    unpaid: members.filter((m) => !m.paid),
    withDues: members.filter((m) => m.dues > 0),
  };
}

// ---------- PDF ----------
const C = {
  dark: '#14161c',
  gold: '#d4a63a',
  goldLight: '#f1cf72',
  ink: '#16181d',
  muted: '#667085',
  line: '#e4e7ec',
  headBg: '#f2f4f7',
  zebra: '#fafbfc',
  ok: '#157f3d',
  okBg: '#e6f6ec',
  warn: '#b54708',
  warnBg: '#fef3e2',
};

const COLS = [
  { key: 'card', label: 'Card no.', width: 60 },
  { key: 'name', label: 'Name', width: 120 },
  { key: 'mobile', label: 'Mobile', width: 76 },
  { key: 'joined', label: 'Joined', width: 66 },
  { key: 'status', label: 'Status', width: 60 },
  { key: 'received', label: 'Received on', width: 70 },
  { key: 'dues', label: 'Months due', width: 71, align: 'center' },
];

// PDF standard fonts only cover Latin text; replace anything else so the PDF never breaks.
const pdfSafe = (s) => String(s ?? '').replace(/[^\x20-\x7E -ÿ]/g, '?');

function fit(doc, text, width) {
  let s = pdfSafe(text);
  if (doc.widthOfString(s) <= width) return s;
  while (s.length > 1 && doc.widthOfString(`${s}…`) > width) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

function drawLogo(doc, x, y, size) {
  doc.save().translate(x, y).scale(size / 120);
  doc.roundedRect(0, 0, 120, 120, 26).fill('#232733');
  doc.path('M28 78 L22 40 L42 56 L60 32 L78 56 L98 40 L92 78 Z').fill(C.gold);
  doc.roundedRect(28, 82, 64, 9, 3).fill(C.gold);
  doc.circle(22, 38, 5).fill(C.goldLight);
  doc.circle(60, 30, 5).fill(C.goldLight);
  doc.circle(98, 38, 5).fill(C.goldLight);
  doc.restore();
}

function renderPdf(r) {
  return new Promise((resolve, reject) => {
    const monthName = fmtMonth(r.month);
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 40, bottom: 50, left: 36, right: 36 },
      bufferPages: true,
      info: { Title: `Royals Gym - Fees report - ${monthName}`, Author: 'Royals Gym' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const now = new Date();

    // Header band
    doc.rect(0, 0, doc.page.width, 96).fill(C.dark);
    drawLogo(doc, left, 20, 56);
    doc.fillColor(C.gold).font('Helvetica-Bold').fontSize(22).text('Royals Gym', left + 70, 26, { lineBreak: false });
    doc.fillColor('#cfd3dc').font('Helvetica').fontSize(12).text(`Fees report  ·  ${monthName}`, left + 70, 54, { lineBreak: false });
    doc
      .fillColor('#9aa1ad')
      .fontSize(9)
      .text(`Generated ${fmtDate(today())}, ${timeFmt.format(now)}`, left, 58, { width, align: 'right', lineBreak: false });

    // Summary boxes
    let y = 116;
    const stats = [
      ['MEMBERS', r.members.length, C.ink],
      ['PAID', r.paid.length, C.ok],
      ['NOT PAID', r.unpaid.length, C.warn],
      ['WITH MONTHS DUE', r.withDues.length, C.warn],
    ];
    const gap = 10;
    const boxW = (width - gap * (stats.length - 1)) / stats.length;
    stats.forEach(([label, value, color], i) => {
      const x = left + i * (boxW + gap);
      doc.roundedRect(x, y, boxW, 54, 8).lineWidth(1).strokeColor(C.line).stroke();
      doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text(label, x + 12, y + 10, { lineBreak: false });
      doc.fillColor(color).font('Helvetica-Bold').fontSize(22).text(String(value), x + 12, y + 23, { lineBreak: false });
    });
    y += 54 + 22;

    const ROW_H = 22;
    const HEAD_H = 22;

    function headerRow() {
      doc.rect(left, y, width, HEAD_H).fill(C.headBg);
      let x = left;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.muted);
      for (const col of COLS) {
        doc.text(col.label.toUpperCase(), x + 6, y + 8, { width: col.width - 12, align: col.align || 'left', lineBreak: false });
        x += col.width;
      }
      y += HEAD_H;
    }

    function newPage() {
      doc.addPage();
      y = doc.page.margins.top;
    }

    function row(m, i) {
      if (y + ROW_H > bottom()) {
        newPage();
        headerRow();
      }
      if (i % 2 === 1) doc.rect(left, y, width, ROW_H).fill(C.zebra);
      doc.moveTo(left, y + ROW_H).lineTo(left + width, y + ROW_H).lineWidth(0.5).strokeColor(C.line).stroke();

      const ty = y + 7;
      let x = left;
      const cell = (col, text, font = 'Helvetica', color = C.ink) => {
        doc.font(font).fontSize(9).fillColor(color);
        doc.text(fit(doc, text, col.width - 12), x + 6, ty, { width: col.width - 12, align: col.align || 'left', lineBreak: false });
      };
      for (const col of COLS) {
        switch (col.key) {
          case 'card': cell(col, m.card_no, 'Courier-Bold'); break;
          case 'name': cell(col, m.name, 'Helvetica-Bold'); break;
          case 'mobile': cell(col, fmtMobile(m.mobile) || '-'); break;
          case 'joined': cell(col, fmtDate(m.join_date)); break;
          case 'status': {
            const label = m.paid ? 'Paid' : 'Not paid';
            doc.font('Helvetica-Bold').fontSize(8);
            const pw = doc.widthOfString(label) + 12;
            doc.roundedRect(x + 6, y + 4.5, pw, 13, 6.5).fill(m.paid ? C.okBg : C.warnBg);
            doc.fillColor(m.paid ? C.ok : C.warn).text(label, x + 12, y + 7.5, { lineBreak: false });
            break;
          }
          case 'received': cell(col, m.paid_on ? fmtDate(m.paid_on) : '-', 'Helvetica', m.paid_on ? C.ink : C.muted); break;
          case 'dues': cell(col, String(m.dues), 'Helvetica-Bold', m.dues > 0 ? C.warn : C.ok); break;
        }
        x += col.width;
      }
      y += ROW_H;
    }

    function section(title, color, list) {
      if (y + 30 + HEAD_H + ROW_H > bottom()) newPage();
      doc.font('Helvetica-Bold').fontSize(13).fillColor(color).text(`${title} (${list.length})`, left, y, { lineBreak: false });
      y += 22;
      if (!list.length) {
        doc.font('Helvetica').fontSize(10).fillColor(C.muted).text('None.', left, y, { lineBreak: false });
        y += 28;
        return;
      }
      headerRow();
      list.forEach(row);
      y += 24;
    }

    section(`Not paid for ${monthName}`, C.warn, r.unpaid);
    section(`Paid for ${monthName}`, C.ok, r.paid);

    if (y + 30 > bottom()) newPage();
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(C.muted)
      .text(
        `"Months due" = unpaid months from ${fmtMonth(FEES_START_MONTH)} (or the joining month, if later) up to ${monthName}.`,
        left,
        y,
        { width }
      );

    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // allow writing in the footer area without adding a page
      const fy = doc.page.height - 30;
      doc.moveTo(left, fy - 8).lineTo(left + width, fy - 8).lineWidth(0.5).strokeColor(C.line).stroke();
      doc.font('Helvetica').fontSize(8).fillColor(C.muted);
      doc.text(`Royals Gym  ·  Fees report  ·  ${monthName}`, left, fy, { lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, left, fy, { width, align: 'right', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }

    doc.end();
  });
}

// ---------- Route ----------
function mount(app, requireAuth) {
  app.get('/api/reports/fees.pdf', requireAuth, async (req, res) => {
    const current = today().slice(0, 7);
    const month = req.query.month ? String(req.query.month) : current;
    if (!MONTH_RE.test(month) || month > current || month < FEES_START_MONTH) {
      return res.status(400).json({ error: 'Invalid month' });
    }
    const pdf = await renderPdf(await buildReport(month));
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="royals-gym-fees-${month}.pdf"`,
      'Content-Length': pdf.length,
      'Cache-Control': 'no-store',
    });
    res.send(pdf);
  });
}

module.exports = { mount, buildReport, renderPdf };
