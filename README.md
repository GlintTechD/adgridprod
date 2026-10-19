# ADGRID Cloud

A Pan-African OOH intelligence and operations platform with a React frontend and a Node.js/Express backend scaffold.

## Quick start

1. Copy [.env.example](.env.example) to `.env` and fill in the required values.
2. Install dependencies:
   `npm install`
3. Run the dev server:
   `npm run dev`
4. Open http://localhost:3000

> **Going to production?** [`docs/PRODUCTION_SETUP.md`](docs/PRODUCTION_SETUP.md)
> is the step-by-step guide: Supabase Postgres (pooler connection strings,
> migrations, Data API lockdown), Resend (domain verification, sending-scoped API
> keys, sender rules), the exact Vercel environment variables, then
> `npm run verify:prod -- --url https://your-domain --strict` to check a live
> deployment. Never paste secrets into issues or commits.

## Backend bootstrap

The app now boots an Express API on the legacy `/api` routes while preserving the Vite dev middleware used by the frontend. The auth flows are implemented in the server bootstrap and support the frontend’s existing contract.

## Scripts

- `npm run dev` — start the Express + Vite dev server
- `npm run build` — build frontend and backend bundle
- `npm run start` — start the production bundle
- `npm run lint` — TypeScript check
- `npm run db:migrate` — Prisma migration workflow
- `npm run db:seed` — seed users and metro data
- `npm run smoke:auth` — simple auth smoke checks
- `npm run smoke:signup` — signup/sign-in journey checks (needs a running server)
- `npm run smoke:otp` — verification-code checks
- `npm run admin:create` — create a Platform Admin without running the demo seed
- `npm run verify:prod` — check a deployed environment's database, email and app URL
- `npm run mock:resend` — local Resend API stand-in (127.0.0.1:4200) for testing the production email path
- `npm run dev:db` / `npm run dev:db:migrate` — embedded Postgres for local work (no Docker required)

## Auth endpoints

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/mfa/verify`
- `POST /api/auth/mfa/enable`
- `POST /api/auth/mfa/confirm`
- `POST /api/auth/mfa/disable`
- `GET /api/auth/me`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `POST /api/auth/validate-access`
- `GET /api/auth/verify-email`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `POST /api/auth/verify-otp` — complete a 6-digit code (also `POST`/`GET /api/auth/verify-email`)
- `POST /api/auth/resend-otp` — request a new code (60s cooldown per account)
- `POST /api/auth/change-verification-email` — correct an address before verifying
- `GET /api/auth/verification-status`
- `GET /api/health/config` — non-secret configuration report for a deployment
- `POST /api/health/config/test-email` — send a real test email (Platform Admin only)

## Email verification codes

Signup creates the account and immediately emails a **6-digit code** through
Resend. The code expires after 10 minutes, allows 5 attempts, and can be
re-requested every 60 seconds. Signing in with an unverified account re-sends a
code and routes the user to `/verify-email`.

Delivery failures are reported precisely instead of silently claiming success:

| Situation | Response |
| --- | --- |
| Provider not configured | `503` `email_delivery_failed` (and a startup error log) |
| Sending domain not verified / bad key | `503` with the Resend status explained (`403`, `401`) |
| Resend unreachable | `503`, retried twice with backoff |
| Cooldown still active | `429` `cooldown_active` with the remaining seconds |

When a send fails the account still exists and stays unverified, so the UI routes
the user to `/verify-email` where they can request another code.

**Local development without an inbox:** with `RESEND_API_KEY` empty and
`NODE_ENV` not `production`, codes are printed to the server console and readable
at `GET /api/auth/dev-last-otp?email=...`. That endpoint returns `404` in
production — `npm run verify:prod` fails the deployment if it is ever readable.

## Vercel Deployment

The project is fully configured for seamless one-click deployment on [Vercel](https://vercel.com):

1. **Import Repository**: Connect your GitHub repository to Vercel.
2. **Framework Preset**: Vercel automatically detects `Vite` (with output directory `dist`).
3. **Build Settings**:
   - Build Command: `npm run vercel-build` (or `npm run build`)
   - Output Directory: `dist`
   - Install Command: `npm install` (runs `postinstall: prisma generate` automatically)
4. **Environment Variables**:
   - `JWT_ACCESS_SECRET` (required): 48+ random bytes
   - `JWT_REFRESH_SECRET` (required): 48+ random bytes
   - `DATABASE_URL` (required): Supabase transaction pooler, port `6543`, with `?pgbouncer=true&connection_limit=1`
   - `DIRECT_URL` (required): Supabase session pooler, port `5432` (migrations)
   - `APP_URL` (required): your deployment URL — emailed links are built from it
   - `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (required): a Sending-access key and a sender on a Resend-verified domain
   - Never set: `PRISMA_DRIVER_ADAPTER`, `ALLOW_DEV_EMAIL_INSPECTION`, `RESEND_API_URL`
   See [`docs/PRODUCTION_SETUP.md`](docs/PRODUCTION_SETUP.md) for the full table.
5. **Serverless Architecture**:
   - Static client assets are hosted on Vercel's Edge Network with immutable cache headers.
   - All `/api/*` endpoints are automatically handled by Vercel Serverless Functions via `/api/index.ts` and `/api/[...path].ts`.
   - Client-side SPA routes (e.g. `/admin`, `/marketplace`, `/admin/agency`) rewrite seamlessly to `index.html` via `vercel.json`.

## Notes

- The application intentionally keeps the old frontend route structure and central auth contract intact.
- Data is persisted in PostgreSQL through Prisma. Set `DATABASE_URL` (and `DIRECT_URL` for migrations) to your Supabase project — see `docs/PRODUCTION_SETUP.md`.

Migrations are not part of the frontend build: run `npm run db:migrate:deploy`
from a trusted step before serving traffic. Never run `npm run db:seed` against
production; create your first administrator with `npm run admin:create`.

> Minor documentation refresh.
