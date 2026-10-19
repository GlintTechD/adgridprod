# ADGRID production setup: Resend email + Supabase Postgres

Sign-in on ADGRID is **email + a 6-digit code**. That means production needs
exactly two services:

| Service | Role |
| --- | --- |
| **Resend** | Delivers the verification code, password-reset link, and invitations |
| **Supabase Postgres** | Stores users, roles, and all platform data |

Google / social sign-in exists in the codebase behind `SUPABASE_URL`, but it is
**off unless you configure it**, and this guide deliberately leaves it off. No
Google Cloud project, no OAuth client, no Supabase Auth settings are involved.

Work through the parts in order. Each part ends with a **verify** step, and
`npm run verify:prod` re-checks the whole deployment at the end.

| Part | What it wires up | Time |
| --- | --- | --- |
| [0](#part-0-prerequisites) | The few values you need to collect | 5 min |
| [1](#part-1-supabase-postgres) | Production database | 15 min |
| [2](#part-2-resend-email) | Verification codes, resets, invitations | 15 min (+ DNS propagation) |
| [3](#part-3-vercel-environment-variables) | Deploy configuration | 10 min |
| [4](#part-4-first-deploy-and-verification) | Go-live checklist | 10 min |

The steps below use `https://adgrids-mwk1.vercel.app` as the example deployment
and `adgrids.com` as the example sending domain. Substitute your own values.

> **Never paste secrets into chat, issues, or commits.** Everything here goes into
> Vercel environment variables, Supabase settings, or your local `.env` (which is
> git-ignored). A secret that has been pasted anywhere should be rotated.

---

## Part 0: Prerequisites

| Item | Why |
| --- | --- |
| Your deployment URL (`https://adgrids-mwk1.vercel.app`) | `APP_URL`, emailed links, verification |
| A Supabase project | The database |
| A Resend account | Transactional email |
| A domain you control, plus DNS access | Resend sends from it. Skip only for the interim test path in 2.4 |
| Vercel project access | Environment variables + redeploy |
| Node.js 20+ on your machine | Running migrations and the bootstrap script |

Generate the two application secrets now (you will paste them in Part 3):

```bash
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
```

Keep them somewhere safe (a password manager). Changing either one later logs
every user out.

---

## Part 1: Supabase Postgres

The application uses Prisma against Supabase Postgres. Supabase is never reached
from the browser — all data access goes through the ADGRID server.

### 1.1 Project

If the project already exists, open it and skip to 1.2. Otherwise:
<https://supabase.com/dashboard> → **New project** → name it, choose the region
closest to your users, set a **strong database password** and store it in your
password manager (you need it URL-encoded in the connection strings).

### 1.2 Collect the two connection strings

**Project Settings → Database → Connection string.** You need both, because
serverless functions and migrations have different requirements:

| Purpose | Mode | Port | Env var |
| --- | --- | --- | --- |
| Runtime traffic (Vercel functions) | **Transaction** pooler | `6543` | `DATABASE_URL` |
| Migrations & scripts | **Session** pooler | `5432` | `DIRECT_URL` |

```
DATABASE_URL="postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"
DIRECT_URL="postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-eu-west-2.pooler.supabase.com:5432/postgres"
```

> **Use the pooler for both.** Direct connections (`db.PROJECT_REF.supabase.co`)
> are IPv6-only on new projects and Vercel's serverless runtime is IPv4, so
> migrations run from your machine or from Vercel fail with a connection timeout.
> The Supavisor pooler is dual-stack. Only use the direct host if you know your
> machine has IPv6.
>
> URL-encode reserved characters in the password (`@` → `%40`, `#` → `%23`,
> `/` → `%2F`). A password containing `@` is the single most common cause of
> "authentication failed" here.

Put both strings in your local `.env` (copy `.env.example` if you have not).

### 1.3 Apply the schema

From your machine, with `DATABASE_URL` and `DIRECT_URL` set:

```bash
npm install
npm run db:generate          # standard Prisma client generation
npm run db:migrate:deploy    # applies prisma/migrations/*  (never destructive)
```

> Do **not** run `npm run db:seed` in production. It creates demo tenants and
> users with a published password. Use Part 4.1 to create your first real
> administrator instead.

### 1.4 Lock down the Data API (important)

ADGRID talks to Postgres directly, so Supabase's auto-generated REST API is not
needed and would expose your tables to anyone holding the publishable key:

1. **Project Settings → API → Data API** → disable it (or expose no schemas).
2. If you cannot disable it, enable **RLS on every table** and create no policies
   for `anon`. Prisma connects as the database owner and is unaffected by RLS,
   while PostgREST would then return nothing.
3. **Project Settings → Database → Network restrictions:** restrict access if
   your plan supports it; otherwise rely on the pooler plus a strong, rotated
   password.

### 1.5 Verify

```bash
npx prisma migrate status        # every migration applied
```

After the deploy in Part 4, the live state is visible at:

```bash
curl -s https://adgrids-mwk1.vercel.app/api/health
# {"status":"ok","db":"connected","users":1,...}
```

`"db":"connected"` is the proof that the runtime URL works from Vercel. If it
says otherwise, re-check `DATABASE_URL` (port `6543`, `pgbouncer=true`).

---

## Part 2: Resend email

Resend delivers every application email: **signup verification codes**, password
resets, invitations, and agency approval notices. Without this part nobody can
verify their email, and therefore nobody can sign in.

### 2.1 Add and verify your sending domain

1. <https://resend.com/domains> → **Add domain** → e.g. `adgrids.com`.
2. Resend shows the DNS records to create. Add them at your DNS provider — the
   shapes below are the pattern, **always copy the exact values Resend shows
   you**, they are unique per domain:

   | Type | Name | Value | Purpose |
   | --- | --- | --- | --- |
   | `TXT` | `resend._domainkey` | `p=MIGfMA0GCSq…` | DKIM signature |
   | `TXT` | `send` | `v=spf1 include:amazonses.com ~all` | SPF (authorises sending) |
   | `MX` | `send` | `feedback-smtp.eu-west-1.amazonses.com` (priority 10) | Return-path / bounces |
   | `TXT` | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@adgrids.com` | *(recommended)* deliverability |

3. Back in Resend, click **Verify DNS records**. Usually minutes; up to 24h if
   TTLs are long.

**Verify:** the domain shows **Verified**. Do not move on before that — sending
from an unverified domain returns `403`, and ADGRID surfaces it as:

> *"Resend refused to send (403). The RESEND_FROM_EMAIL domain is most likely not
> verified for this API key."*

### 2.2 Create the API key

1. <https://resend.com/api-keys> → **Create API key**.
2. Name: `adgrids-production`. **Permission: Sending access** — not Full access.
3. **Domain:** restrict it to your sending domain.
4. Copy the key (`re_…`). It is shown once. This becomes `RESEND_API_KEY`.

### 2.3 Set the sender

```
RESEND_FROM_EMAIL="ADGRID Security <no-reply@adgrids.com>"
```

Rules that matter:

- The address **must be on the verified domain** — a `gmail.com` sender will be
  refused no matter how the key is scoped.
- Keep the `Display Name <email@domain>` form; a bare address works but displays
  as the raw address in most clients.
- `no-reply@` discourages replies. If you want replies, point that address at a
  real mailbox (an MX/A record, not a DNS-only record).

### 2.4 Interim: get codes flowing before DNS is finished

While DNS propagates you can still prove the whole flow end to end using Resend's
shared test sender:

```
RESEND_FROM_EMAIL="ADGRID <onboarding@resend.dev>"
```

Resend only delivers `onboarding@resend.dev` mail **to the address that owns the
Resend account**, so this is a smoke test, not a launch configuration. ADGRID's
startup log warns about it and `npm run verify:prod` reports it as a failure —
that is deliberate. Swap to your verified domain in 2.3 before real users arrive.

### 2.5 Dry-run the whole email path locally (no DNS, no credits)

To exercise the real code path without sending anything, run the bundled Resend
stand-in. It speaks the real Resend API, so the app runs in production mode with
no test hooks:

```bash
node scripts/mock-resend.mjs                       # terminal 1 — stand-in on 127.0.0.1:4200

PORT=3300 NODE_ENV=production APP_URL=http://localhost:3300 \
RESEND_API_KEY=re_local_test \
RESEND_FROM_EMAIL="ADGRID Security <no-reply@adgrids.test>" \
RESEND_API_URL=http://127.0.0.1:4200/emails \
npx tsx server.ts                                  # terminal 2
```

```bash
# 1. Sign up — the code goes to the stand-in instead of a real inbox
curl -s -X POST http://localhost:3300/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"name":"Local Check","email":"localcheck@adgrids.test","password":"SecurePassword2026!","organization":"Local Co","role":"Customer / Client Company"}'

# 2. Read the code the email actually contains
curl -s "http://127.0.0.1:4200/__last-otp?to=localcheck@adgrids.test"

# 3. Verify, then sign in
curl -s -X POST http://localhost:3300/api/auth/verify-otp -H 'Content-Type: application/json' \
  -d '{"email":"localcheck@adgrids.test","code":"<code from step 2>"}'
```

Expected: signup `201`, `/api/auth/dev-last-otp` `404` (correct in production
mode), verification succeeds, and sign-in returns the dashboard for that role.
`GET http://127.0.0.1:4200/__inbox` lists every payload the app posted, so you can
read the exact HTML a recipient would receive.

### 2.6 Verify against the real service

With real credentials in `.env`, locally:

```env
RESEND_API_KEY="re_your_key"
RESEND_FROM_EMAIL="ADGRID Security <no-reply@adgrids.com>"
```

```bash
npm run dev
# sign up at http://localhost:3000/admin and confirm the code arrives
```

Against the deployment, signed in as a Platform Admin (see Part 4.1):

```bash
curl -X POST https://adgrids-mwk1.vercel.app/api/health/config/test-email \
  -H "Authorization: Bearer <access token>" \
  -H "Content-Type: application/json" -d '{}'
# {"success":true,"message":"Test email sent to you@adgrids.com.","providerMessageId":"…"}
```

`200` with a message id means Resend accepted the message; it then appears in the
Resend dashboard with a live delivery status.

---

## Part 3: Vercel environment variables

### 3.1 Set the variables

Vercel → your project → **Settings → Environment Variables**. Add these to
**Production** (use separate values for Preview/Development if you deploy
previews):

| Variable | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | Vercel sets it; set it explicitly anyway |
| `APP_URL` | `https://adgrids-mwk1.vercel.app` | Emailed links + redirects. Wrong value = links to localhost |
| `DATABASE_URL` | `postgresql://…pooler…:6543/…?pgbouncer=true&connection_limit=1` | Part 1.2 — transaction pooler |
| `DIRECT_URL` | `postgresql://…pooler…:5432/…` | Part 1.2 — session pooler |
| `JWT_ACCESS_SECRET` | 48 random bytes | From Part 0. Changing it logs everyone out |
| `JWT_REFRESH_SECRET` | 48 random bytes | From Part 0 |
| `ACCESS_TOKEN_TTL` | `15m` | Optional |
| `RESEND_API_KEY` | `re_…` | Part 2.2 |
| `RESEND_FROM_EMAIL` | `ADGRID Security <no-reply@adgrids.com>` | Part 2.3 |

**Deliberately NOT set in production:**

| Variable | Why |
| --- | --- |
| `PRISMA_DRIVER_ADAPTER` | Local-only switch that swaps Prisma onto the WASM engine. A stray copy from `.env` used to break every endpoint at import; the app now ignores it on serverless rather than fail |
| `DEMO_AUTH_ENABLED` | Demo accounts share one password that is published to the sign-in screen, and one of them is a Platform Admin. Production refuses it regardless of what is set here |
| `DEMO_PROVISIONING` | Writing demo rows is off on any deployment unless this is `1`. Preview deployments use the same `DATABASE_URL` as production unless you scope it to Production only, so without this guard an open pull request creates tenants and forces live accounts to `ACTIVE` + verified just by building |
| `ALLOW_DEV_EMAIL_INSPECTION` | Unset already disables the endpoint, because `NODE_ENV=production` |
| `RESEND_API_URL` | Only used to point at a mock Resend in tests |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `SUPABASE_OAUTH_AUTO_PROVISION` | These switch on social sign-in. Leaving them unset keeps the email + code flow as the only way in |

### 3.2 Redeploy, then migrate

Environment changes only take effect on a new deployment: **Deployments → … →
Redeploy** (or push to the production branch).

The build runs `npm run vercel-build` (`prisma generate && vite build`). Prisma
Client is generated during the build; **migrations are not** — apply them
explicitly whenever the schema changes:

```bash
npm run db:migrate:deploy   # from your machine or a trusted CI step
```

Recommended for repeatability: a GitHub Action that runs `db:migrate:deploy`
before promoting a production deploy, so schema changes are never applied by hand.

---

## Part 4: First deploy and verification

### 4.1 Create your administrator

Never run the demo seed in production. Create one Platform Admin:

```bash
# with production DATABASE_URL/DIRECT_URL in .env
npm run admin:create -- --email you@adgrids.com --name "Your Name"
# → prints a generated password once; sign in at /admin
```

The script prints the masked database host it is about to write to — check it is
your Supabase host before confirming.

### 4.2 Run the configuration check

From your machine, in the repository:

```bash
npm run verify:prod -- --url https://adgrids-mwk1.vercel.app
```

It reports the live truth for: database connectivity, Resend configuration,
whether the dev code outbox is correctly disabled, social sign-in state, and any
warnings the deployment itself raises. `--strict` also fails on warnings, which
is what you want before launch.

A healthy run ends with `failures: 0 | warnings: 0` and exit code `0`. If it says
`/api/health/config unavailable`, the deployment does not include this code yet —
deploy first, then re-run.

### 4.3 Walk the real journeys

| Journey | Expected |
| --- | --- |
| Sign up at `/admin` | Account created → 6-digit code arrives within a minute → verify → dashboard |
| Sign in before verifying | Blocked, routed to `/verify-email`, code offered again |
| Resend the code | Allowed after 60s; blocked with a countdown before that |
| Wrong code 5× | Code invalidated, clear message, request a new one |
| Forgot password | Email arrives; link points at your domain; new password works |
| Invite a user | Invitation email arrives; accept → correct role dashboard |
| Unknown email at sign-in | No account enumeration; generic response |

### 4.4 What "done" looks like

```bash
npm run verify:prod -- --url https://adgrids-mwk1.vercel.app --strict
# failures: 0 | warnings: 0   (exit code 0)
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `503 email_delivery_failed` "Could not reach Resend (ENOTFOUND)" | Server has no outbound DNS/HTTPS to `api.resend.com` | Check egress rules; `RESEND_API_URL` must stay unset in production |
| `403 … domain is most likely not verified` | Domain not verified, or sender on a different domain | Finish DNS verification; sender must match the verified domain |
| `401 Resend rejected the API key` | Wrong, revoked, or over-restricted key | Re-issue a Sending-access key restricted to your domain |
| Codes reach you but nobody else | Still sending from `onboarding@resend.dev` | Verify your domain and switch `RESEND_FROM_EMAIL` (Part 2.3) |
| Nothing arrives, no error | Check the spam folder, then the Resend dashboard's delivery status | Add the DMARC record; keep the display name consistent |
| Signup works locally, `503` in production | `RESEND_API_KEY` / `RESEND_FROM_EMAIL` missing in Vercel | Set them, then **redeploy** — env changes need a new deployment |
| `P1001: Can't reach database server` | IPv6-only direct connection from IPv4 serverless | Use the Supavisor pooler URLs (Part 1.2) |
| `prepared statement "s0" already exists` | Transaction pooler without the pgbouncer flag | Keep `?pgbouncer=true&connection_limit=1` in `DATABASE_URL` |
| `db: error: Environment variable not found: DIRECT_URL` | Migration run without the session URL | Set `DIRECT_URL` in the environment you migrate from |
| Codes emailed but links point at `localhost` | `APP_URL` unset or wrong | Set `APP_URL` to the deployment URL and redeploy |
| Verification code rejected as incorrect | Code expired (10 min) or 5 attempts used | Request a new code; codes are single-use |
| `429 cooldown_active` | A code was requested less than 60s ago | Wait the reported seconds; that is the anti-abuse limit |
| Everyone logged out after deploy | `JWT_ACCESS_SECRET` changed | Expected — keep it stable, rotate deliberately |
| `/api/health/config` returns 404 | Deployment predates this tooling | Deploy the current branch, then re-run the check |

## How this document was validated

The steps were executed as far as the absence of live credentials allows, against
the real application code rather than a sketch of it:

| Check | How it was verified |
| --- | --- |
| Production email path end to end | App run with `NODE_ENV=production` against a Resend-API stand-in: signup `201` → code taken from the delivered HTML → `verify-otp` succeeded → sign-in returned the role dashboard; password-reset link pointed at `APP_URL` |
| Dev code outbox is sealed in production | `GET /api/auth/dev-last-otp` returned `404` on that instance |
| An unverified sender is diagnosed, not hidden | Sender moved to an unverified domain: signup answered `email_delivery_failed` with a clean user-facing message, and the server log carried the exact Resend `403` reason |
| Bootstrap + admin-only test email | `npm run admin:create` produced a Platform Admin whose login redirects to `/admin/platform`; `POST /api/health/config/test-email` returned `200` for that admin and `401` unauthenticated |
| Verifier behaviour | `npm run verify:prod` passes on a correctly configured instance and reports the expected failures/warnings on a development box |
| Database | Prisma run against a real in-sandbox Postgres over the wire protocol, including the migration history |

Not verifiable from the build environment, and therefore to re-confirm on the
real project: live sends through `api.resend.com` (sandbox has no outbound access)
and connectivity from Vercel to your Supabase pooler (Part 1.5's `/api/health`
call is the check).

## Security checklist

- [ ] `RESEND_API_KEY` has **Sending** access only, restricted to your domain
- [ ] Supabase **Data API / PostgREST disabled** (or RLS everywhere, no `anon` policies)
- [ ] Production DB password is strong, URL-encoded, and in a password manager
- [ ] `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` are 48+ random bytes, unique per environment
- [ ] `PRISMA_DRIVER_ADAPTER` and `ALLOW_DEV_EMAIL_INSPECTION` are absent in production
- [ ] `SUPABASE_*` variables are absent, so social sign-in stays disabled
- [ ] `npm run verify:prod -- --strict` passes
- [ ] `db:seed` never run against production
- [ ] Supabase backups enabled (Project Settings → Database → Backups)
- [ ] An alert exists for spikes in `LOGIN_FAILED` / `OTP_SEND_FAILED_ON_LOGIN` in `AuditLog`
