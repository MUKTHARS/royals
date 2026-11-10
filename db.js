const pg = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings (avoids timezone shifts).
pg.types.setTypeParser(1082, (v) => v);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  age         INTEGER NOT NULL,
  mobile      VARCHAR(15),
  card_no     VARCHAR(20) NOT NULL UNIQUE,
  join_date   DATE NOT NULL,
  attending   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per member per calendar month that has been paid.
-- No row = not paid for that month. Rows are never deleted by the app (paid stays paid).
CREATE TABLE IF NOT EXISTS fee_payments (
  id         SERIAL PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  month      VARCHAR(7) NOT NULL,
  paid_on    DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (member_id, month)
);
`;

let pool;

async function init() {
  if (process.env.DATABASE_URL) {
    // Neon gives "sslmode=require"; use the equivalent explicit full certificate check (silences a pg warning).
    const connectionString = process.env.DATABASE_URL.replace(/sslmode=(prefer|require|verify-ca)\b/, 'sslmode=verify-full');
    pool = new pg.Pool({ connectionString, max: 5 });
  } else {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required in production.');
    }
    // Local trial mode only: in-memory Postgres emulator. Data is lost on restart.
    const { newDb } = require('pg-mem');
    const mem = newDb();
    const adapter = mem.adapters.createPg();
    pool = new adapter.Pool();
    console.warn('[db] No DATABASE_URL set — using an in-memory database (data is lost on restart).');
  }
  await pool.query(SCHEMA);
  // Upgrade databases created before the mobile field existed.
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'members' AND column_name = 'mobile'`
  );
  if (!rows.length) await pool.query('ALTER TABLE members ADD COLUMN mobile VARCHAR(15)');
}

function query(text, params) {
  return pool.query(text, params);
}

module.exports = { init, query };
