# Tess Protocol

Tess Protocol is a simulated-funds prototype. It is not a financial product and is not production-ready. Demo balances have no real monetary value; no custody, payment processing, blockchain transfer, or exchange order is performed.

## Local development

Requirements: Node.js 22.12+ and npm.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`). Local API calls are proxied to Express on port 3001. Local development/tests continue to use SQLite at `data/tess.sqlite`; its schema is applied from `server/migrations/001_initial.sql`. Local SQLite data is ignored by Git and must not be used as a production database.

## Vercel architecture

Vercel serves the Vite `dist` frontend and routes `/api/*` to the Express catch-all function in `api/[...route].ts`. The app is explicitly configured as Vite in `vercel.json`; the catch-all is a Node.js function that exports the Express app. The hosted API uses Supabase Postgres for users, wallet balances, the claim marker, ledger, sessions, audit events, and shared credential throttling. Supabase Storage is the intended private location for future identity samples. The browser receives no database or Supabase service-role credentials.

Local Express/SQLite remains the development adapter. Vercel uses the separate hosted Postgres implementation. Run `npm run build` to type-check both server code paths and build the frontend.

## Required service setup

Complete these steps before deploying:

1. Create a Supabase project and copy its Postgres connection string from **Connect**. Use the transaction pooler URL for a serverless deployment, with TLS required (`sslmode=require`). `DATABASE_URL` must be the server-only connection string, not a `VITE_` variable.
2. In the Supabase SQL editor or from a trusted local terminal configured with `DATABASE_URL`, apply the hosted schema:

   ```powershell
   npm run db:migrate:hosted
   ```

   This creates the Postgres tables and indexes needed by the hosted API. Do not run the SQLite migration against Supabase.
3. Create a Supabase Storage bucket named `identity-samples-private` (or set a different `SUPABASE_IDENTITY_BUCKET`). Keep **Public bucket** disabled. Do not add anonymous/authenticated read policies or expose object URLs. The current project has no identity-upload implementation, so no service-role storage operations are exposed by the API.
4. Configure the following environment variables in Vercel Project Settings for Preview and Production as appropriate:

   | Variable | Value | Exposure |
   | --- | --- | --- |
   | `DATABASE_URL` | Supabase Postgres transaction-pooler connection string with TLS | Server only |
   | `SESSION_SECRET` | Random secret, at least 32 characters | Server only |
   | `SUPABASE_URL` | Project URL | Server only for future storage operations |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key | Secret, server only; never use in browser code |
   | `SUPABASE_IDENTITY_BUCKET` | Private bucket name, e.g. `identity-samples-private` | Server only |

   Generate a session secret locally with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`, then enter it directly in Vercel settings. Do not commit it or paste it into source files. `.env.example` contains variable names and placeholders only.
5. Vercel currently defaults to Node.js 24.x. The package engine range supports Node 22.12 through 24, and Vercel resolves that range to 24.x; confirm the selected version under Project Settings → Build and Deployment. `vercel.json` specifies the Vite build/output and API function duration. After deployment, verify `/api/health` returns `{"status":"ok","mode":"simulated"}`, register a test user, claim demo funds, sign out/in, and verify the claim remains unavailable.
6. Create an administrator only after the migration and environment variables are set. From a trusted machine with `DATABASE_URL` and `SESSION_SECRET` in its uncommitted `.env`, run `npm run admin:create:hosted`. This is an operator-side script, not a web role-elevation route. Use a unique strong password. The local-only `npm run admin:create` command writes to SQLite and does not create a hosted administrator.

Do not put any of the server-only values in `VITE_*` variables, frontend constants, source control, screenshots, logs, or support messages. Never use the Supabase `anon` or service-role key as the database connection string. Rotate credentials immediately if exposed.

## Hosted migrations and account data

`npm run db:migrate:hosted` applies `server/migrations/002_postgres.sql` using `DATABASE_URL`. It is idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`) and is intended to run from a trusted operator environment, not automatically during a serverless cold start. Back up Supabase before schema changes. The migration creates an empty hosted database; it does not copy the local SQLite account or claim. Local demo accounts are disposable test data and should not be migrated.

`npm run admin:create:hosted` prompts for admin details and stores bcrypt hashes. Do not expose or modify the role through the client. If the terminal session is recorded, use a password that is unique to this demo and rotate it after setup.

## One-time demo funds

The Deposit page offers **Start demo with $1,000** and confirms that the credit is fictional. Hosted Postgres inserts a row into `demo_claims` with a per-user primary key, credits exactly 100,000 integer cents to General, and writes the “Demo starting funds” ledger entry in the same transaction. A conflict does not credit again. This remains true across function instances, sessions, devices, retries, and spending. No top-up or balance-reset route exists. The UI shows the claimed disabled state from hosted persisted profile data after refresh/login.

## Identity files and review

There is no local identity upload implementation to migrate: the current Identity Review page is explicitly disabled and accepts no files. A private Supabase bucket can be provisioned for future work, and `server/private-storage.ts` only creates a server-side client from secret environment variables. It does not add an upload/download endpoint or return signed/public URLs. Keep identity submission disabled until the app implements and tests actual-content MIME decoding, size limits, raster allowlisting, metadata stripping, application-level encryption/key handling, owner/admin authorization, rejection reason/resubmission, audit logging, and explicit secure deletion/retention. Do not upload real identity documents to this prototype.

Administrator review endpoints remain role-gated, reject self-review, and audit decisions. The current frontend has no working identity submission or administrator review interface. Manual sample review would not establish Ghana Card authenticity or perform authoritative identity/biometric checks.

## Validate

```powershell
npm run test
npm run build
npm run lint
```

The automated database tests use SQLite and cover exact first grant, duplicate and concurrent requests, persistence across logout/login, spending, locked-session rejection, and duplicate registration. They do not connect to Supabase. Before production deployment, run the hosted smoke test above against a non-production Supabase project and verify cookie behavior over HTTPS in a Vercel Preview deployment.

## Current scope and remaining decisions

Implemented: registration/login, unique normalized identifiers, bcrypt-hashed password/PIN/withdrawal password, CSRF, HttpOnly secure hosted cookies, Postgres-persisted hosted sessions, shared hosted credential throttling, lock/PIN unlock/logout, three wallet records, one-time starting credit, General/Trading transfers, transaction history, referrals code display, and role-gated identity-review API decisions.

Still disabled/incomplete: identity file submission and review UI; private encrypted document handling and deletion; withdrawal processing and its identity/password/fee checks; manual trade previews/codes; bot plans and shared daily caps; stake creation/settlement; referral attribution/counting and rewards; administrator account/ledger UI; credential changes; and UI/device automation. Withdrawal fee, reward assumptions, daily caps, staking reward/early redemption, and referral commission rules need product approval. Contact ownership and account recovery remain unresolved; no OTP or password-reset bypass is implemented.

`npm audit` and `npm audit --omit=dev` currently report zero known vulnerabilities after updating Vitest. Repeat both audits before deployment. The current application is a local/deployment prototype only, not a production financial platform.

Before any real-money use, independently select and integrate compliant payment, custody, exchange, and identity providers; decide account recovery and contact verification; complete security/privacy/legal review; implement encrypted private identity-file handling, retention/deletion, monitoring, backups, rate-limit operations, incident response, secrets rotation, and production-grade tests. Do not connect real funds to this project.