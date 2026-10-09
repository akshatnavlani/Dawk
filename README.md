# Dawk

Local Phase 1 app through M2. The web app is Next.js. The API is Hono on Bun. Postgres is the database. Sign-in works locally. Projects, invites, and agents are later milestones.

## Prerequisites

Install these on Windows before the first run:

- Git
- [Bun](https://bun.sh) 1.4 or newer
- Node.js 20 or newer (the Next.js dev server uses Node; Bun installs packages and runs the API)
- Postgres 15 or newer

Docker is not required. Do not add Kubernetes, Redis, MongoDB, FastAPI, or web3 for this milestone.

### Windows install hints

Bun and Node:

```powershell
winget install Oven-sh.Bun
winget install OpenJS.NodeJS.LTS
```

Postgres: install Postgres 15+ with `winget install PostgreSQL.PostgreSQL.17`, or use the installer from the PostgreSQL Windows downloads page. After install, add the `bin` directory to your PATH if `psql` is not found. A typical path is `C:\Program Files\PostgreSQL\17\bin`.

## First-time setup

From the repo root in PowerShell:

```powershell
copy .env.example .env
```

Edit `.env` and set:

- `DATABASE_URL` — local Postgres. The shape is `postgres://USER:PASSWORD@127.0.0.1:5432/dawk`.
- `SESSION_SECRET` — at least 32 random characters. This signs session cookies.
- `CREDENTIALS_ENCRYPTION_KEY` — at least 32 random characters. This encrypts Owner provider keys. It must be different from `SESSION_SECRET`.
- `APP_URL` — `http://127.0.0.1:3000` for local dev. No trailing slash.

Put the real database password and session secret only in `.env`. That file is gitignored. `.env.example` stays empty on purpose.

Create the database (replace the user if yours is not `postgres`):

```powershell
psql -U postgres -c "CREATE DATABASE dawk;"
```

Install dependencies:

```powershell
bun install
```

## Run

One terminal, from the repo root:

```powershell
bun run dev
```

Or two terminals:

```powershell
bun run dev:api
```

```powershell
bun run dev:web
```

Then open the app at http://127.0.0.1:3000 (not `localhost`). The session cookie is stored for the host `127.0.0.1`, so a `localhost` tab will not send it.

- Web: http://127.0.0.1:3000
- Sign in: http://127.0.0.1:3000/login
- API health: http://127.0.0.1:3001/health

The status page reads the API from the Next.js server at `http://127.0.0.1:3001/health`. Reload the page to check again.

A healthy API response looks like:

```json
{"ok":true,"service":"dawk-api","db":"up"}
```

If Postgres is down, `db` is `"down"` and the HTTP status is 503. The process stays up. If `DATABASE_URL`, `SESSION_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, or `APP_URL` is missing, or the two secrets match, the API exits and prints how to fix it.

## Checks

```powershell
bun run db:ping
bun run typecheck
bun run lint
bun run test
bun run format
```

`db:ping` prints `db: up` and exits 0 when `SELECT 1` succeeds.

## Migrations

M1 adds the Phase 1 project tables. M2 adds sessions, magic-link tokens, email-change tokens, and Google OAuth state. Apply migrations after Postgres is up:

```powershell
bun run db:migrate
```

Roll back the latest migration only when the domain tables are empty:

```powershell
bun run db:migrate:down
```

`bun run db:test:schema` migrates up, checks constraints inside a transaction that rolls back, migrates down, then migrates up again. Do not run it against a database that already has rows you need. `bun run test` covers signup, login, logout, magic link, change-email, rate limit, and the Google callback with a stub. It does not call Google.

## Sign in

Open http://127.0.0.1:3000/signup or http://127.0.0.1:3000/login.

Password signup and login talk to the API with an httpOnly cookie named `dawk_session`. A magic-link request always answers the same way. Until Resend is wired (M10), the API prints the one-time link in its console. Open that link in the browser. It expires in 15 minutes and works once.

Change email from the account page. The address does not change until you open the confirmation link from the API console.

Google sign-in is implemented but stays off until `.env` has `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. In Google Cloud, create an OAuth client and register this redirect URI exactly:

```text
http://127.0.0.1:3001/auth/google/callback
```

Then start at http://127.0.0.1:3001/auth/google/start. A successful login lands on `/account`. Cancelling returns to `/login`. If the Google env names are empty, that start URL returns `google_not_configured` and password plus magic link still work.

## Layout

- `apps/web` — Next.js, Tailwind, TypeScript on `127.0.0.1:3000`
- `apps/api` — Hono on Bun on `127.0.0.1:3001`
- `.env.example` — variable names and purposes only

## Secrets

Do not commit `.env`, API keys, passwords, or session tokens. `SESSION_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` must differ. Credential encryption and Resend are later milestones. Leave those values blank until that work starts.

## Scope right now

Local only. A message in the Orchestrator channel starts a run on the Owner's saved key. The reply and working notes show in the channel. Invites come in a later milestone. Hosting vendors stay undecided until M13.
