# Royals Gym – Members Dashboard

Single-admin web app to manage gym members: name, age, membership card no. (e.g. `E-123`),
date of joining, fees paid / not paid, and coming / not coming. Works on desktop and mobile.

## Monthly fees
- Fees are tracked **per calendar month** (Indian time, `Asia/Kolkata`; change with the `APP_TIMEZONE` env var).
- On the 1st of every month, everyone shows **Not paid** for the new month. The admin ticks "Received" as each person pays.
- Once a month is marked **Paid** it is locked — there is no way to change it back to not paid.
- Records start from **January 2026** (`FEES_START_MONTH=2026-01`). Earlier months can't be viewed or marked.
- Use ‹ › at the top of the dashboard to view or mark earlier months (e.g. late payments). Future months can't be marked.
- Each member's **History** button shows every month from Jan 2026 (or their joining month, if later) to now,
  and lets you mark any missed month. The list shows "N months due" per member.
- When marking a payment you enter the **date received** (defaults to today for the current month).
- Each month only lists members who had joined by then.

## Monthly fees report (PDF)
The **Download PDF** button next to the month name downloads that month's fees report: summary counts,
a "Not paid" list and a "Paid" list (card no., name, mobile, joined, date received, months due).
Switch months with ‹ › first to download an earlier month. Code: `report.js`.

### Database tables (created automatically on first start)
- `members` – id, name, age, mobile, card_no (unique), join_date, attending
- `fee_payments` – member_id, month (`YYYY-MM`), paid_on (date received); one row per paid month,
  unique per member + month. No row = not paid.

**Stack:** Node.js + Express (serves pages and API), PostgreSQL, Argon2id password hashing.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
```

Without `DATABASE_URL` in `.env`, it uses a throwaway in-memory database (good for trying it out).
Put a Neon connection string in `.env` to use the real database.

Login: `admin@royalsgym.in` (password given separately — only its Argon2id hash is stored).

### Change the admin password

```bash
npm run hash-password -- "NewPassword"
```
Put the printed hash in `ADMIN_PASSWORD_HASH` (in `.env` locally and in Render's Environment tab), then restart.

### Change the logo
Replace `public/logo.svg` with your logo. For a PNG, save it as `public/logo.png` and change
`/logo.svg` to `/logo.png` in `public/dashboard.html` and `public/login.html`.

## Free hosting: Neon (database) + Render (app)

### 1. Database – Neon (free: 0.5 GB storage, plenty for thousands of members)
1. Sign up at https://neon.tech → **Create project** (pick the region nearest you, e.g. Singapore).
2. Copy the **connection string** (`postgresql://...neon.tech/neondb?sslmode=require`).
   The `members` table is created automatically on first start.

### 2. Code – GitHub
Push this folder to a **private** GitHub repo (`.env` is git-ignored, so secrets are not uploaded).

### 3. App – Render (free web service)
1. Sign up at https://render.com → **New → Blueprint** → choose the repo (it reads `render.yaml`).
2. When asked, fill in:
   - `ADMIN_PASSWORD_HASH` – the hash from your `.env` (without the surrounding quotes)
   - `DATABASE_URL` – the Neon connection string
   (`JWT_SECRET` is generated automatically.)
3. Deploy. Your app will be at `https://royals-gym.onrender.com` (or similar).

**Free-tier note:** Render's free service sleeps after 15 minutes without visits, so the first
visit after a break takes ~30–60 seconds to load. After that it's fast. Upgrading to the $7/month
plan removes this.

## Security summary
- Password stored only as an **Argon2id** hash (64 MiB memory, 3 iterations).
- Login rate-limited to 5 failed attempts per 15 minutes per IP.
- Session in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie, expires after 12 hours.
- Same-origin + JSON-only checks on every change (CSRF protection), strict Content-Security-Policy via Helmet.
- All inputs validated on the server; card numbers are unique.
