// Copy ALL current data (every member and every fee payment) into the Google Sheet as SNAPSHOT rows.
// Run once after setting up the sheet, and any time you want a full copy:  npm run backup-all
require('dotenv').config();
const db = require('../db');
const backup = require('../backup');

(async () => {
  if (!backup.enabled()) throw new Error('Set SHEETS_WEBHOOK_URL and SHEETS_WEBHOOK_SECRET in .env first.');
  await db.init();

  const { rows: members } = await db.query(
    'SELECT id, name, age, mobile, card_no, join_date, attending FROM members ORDER BY id'
  );
  const { rows: payments } = await db.query('SELECT member_id, month, paid_on FROM fee_payments ORDER BY member_id, month');
  const byId = new Map(members.map((m) => [Number(m.id), m]));

  for (const m of members) backup.record('SNAPSHOT_MEMBER', m, { details: 'Full backup' });
  for (const p of payments) {
    const m = byId.get(Number(p.member_id)) || { id: p.member_id };
    backup.record('SNAPSHOT_FEE', m, { fee_month: p.month, fee_status: 'Paid', paid_on: p.paid_on, details: 'Full backup' });
  }

  const done = await backup.flushAll(5 * 60_000);
  if (!done) throw new Error(`${backup.pending()} rows could not be written — check the URL/secret and try again.`);
  console.log(`Backed up ${members.length} members and ${payments.length} fee payments to the Google Sheet.`);
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
