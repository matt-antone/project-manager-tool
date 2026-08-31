# Basecamp Clone v1

Next.js + Supabase + Dropbox implementation based on `PLAN.md`.

## Features
- Google OAuth callback domain enforcement
- Projects, discussions, comments APIs
- Markdown sanitize + render utility
- Dropbox-backed file metadata + temporary links
- Best-effort transactional email notifications for new discussions and comments
- Canonical project identity: `CLIENTCODE-0001-Title`
- Dropbox project working directories: `/projects/<CLIENTCODE>/<PROJECT_CODE>-<Project title>/uploads` (title sanitized for path safety)
- Basecamp 2 import job endpoints with idempotent mapping tables
- Working authenticated UI with route-based navigation
- Settings page at `/settings` with tabbed client and site branding management
- Configurable site title and logo served through `/site-settings`
- Optional project deadlines in create, edit, and project detail flows
- Project detail payload includes archived user-hours roster data
- Dropbox folder links are opened client-side from authenticated JSON responses
- Navigation:
  - `/` list/create/edit projects
  - `/:id` project view and discussion creation
  - `/:id/:discussion` discussion thread and comments

## Run
1. `cp .env.example .env.local`
2. Fill env vars.
3. `npm install`
4. Run SQL in:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_clients.sql`
   - `supabase/migrations/0003_project_status.sql`
   - `supabase/migrations/0004_user_profiles.sql`
   - `supabase/migrations/0005_project_identity_and_storage.sql`
   - `supabase/migrations/0006_project_tags_taxonomy.sql`
   - `supabase/migrations/0007_comment_attachments.sql`
   - `supabase/migrations/0008_project_requestor_personal_hours.sql`
   - `supabase/migrations/0009_project_user_hours.sql`
   - `supabase/migrations/0010_site_settings_and_project_deadline.sql`
5. `npm run dev`

Required server env vars:
- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `WORKSPACE_DOMAIN`
- `NEXT_PUBLIC_SITE_URL` (recommended for production redirects; example `https://projects.yourcompany.com`)

Email env vars:
- `EMAIL_ENABLED` (optional, defaults to `true`)
- `EMAIL_FROM` (canonical sender; if unset, falls back to `MAILGUN_EMAIL`)
- `MAILGUN_EMAIL` (legacy fallback alias for `EMAIL_FROM`)
- `MAILGUN_API_KEY` (required when email is enabled)
- `MAILGUN_DOMAIN` (required when email is enabled)
- `MAILGUN_BASE_URL` (optional, defaults to `https://api.mailgun.net`)

Dropbox env vars:
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`
- `DROPBOX_SELECT_USER` (required for Dropbox Business team tokens with team member file access)
- `DROPBOX_SELECT_ADMIN` (optional alternative for admin-oriented team access)
- `DROPBOX_PROJECTS_ROOT_FOLDER` (optional, defaults to `/projects`)

Thumbnail worker env vars (recommended for Office/PDF conversion in hosted deployments):
- `THUMBNAIL_WORKER_URL` (when set, app delegates thumbnail generation to external worker; must be the worker origin only, for example `https://thumbs.example.internal`, with no `/thumbnails` path or other suffix)
- `THUMBNAIL_WORKER_TOKEN` (required when `THUMBNAIL_WORKER_URL` is set; use the raw secret or `Bearer <secret>`)
- `THUMBNAIL_WORKER_TIMEOUT_MS` (optional, defaults to `15000`)

## Mailgun Transactional Email
- Configure a Mailgun sending domain and API key with permission to send messages.
- Set `EMAIL_FROM` to your shared sender (canonical), for example `notifications@yourcompany.com`. `MAILGUN_EMAIL` is also accepted as a legacy fallback alias.
- If needed, set `MAILGUN_BASE_URL` for region-specific API hosts; otherwise the default `https://api.mailgun.net` is used.
- Thread and comment API writes still succeed if email delivery fails. Failures are logged server-side as `transactional_email_failed`.

## API Paths
- `POST /auth/google/callback`
- `GET|POST /projects`
- `GET|POST /clients`
- `GET /projects/:id`
- `PATCH /projects/:id`
- `GET|PATCH /site-settings`
- `GET /projects/:id/folder-link`
- `POST /projects/:id/archive`
- `POST /projects/:id/restore`
- `GET|POST /projects/:id/threads`
- `GET /projects/:id/threads/:threadId`
- `POST /projects/:id/threads/:threadId/comments`
- `PATCH /projects/:id/threads/:threadId/comments/:commentId`
- `POST /projects/:id/files/upload-init`
- `POST /projects/:id/files/upload-complete`
- `GET /projects/:id/files`
- `GET /projects/:id/files/:fileId/download-link`
- `POST /admin/imports/basecamp2`
- `GET /admin/imports/:jobId`
- `POST /admin/imports/:jobId/retry-failed`

## Tests
- `npm test` runs unit + integration tests.
- `tests/e2e/user-flow.spec.ts` is an E2E flow placeholder to wire into Playwright/Cypress.

## Before First Login
- In Supabase Auth settings, enable Google provider.
- In Supabase Auth URL Configuration, set `Site URL` to your production app URL.
- Add every allowed app origin to Supabase redirect URLs, including local development (`http://localhost:3000`) and your production URL.
- Set `NEXT_PUBLIC_SITE_URL` in production so OAuth always returns to the public app domain instead of a fallback host such as `localhost`.

## Dropbox Refresh Token Helper
- Script: `npm run dropbox:refresh-token -- --code <AUTH_CODE> --app-key <APP_KEY> --app-secret <APP_SECRET>`
- You can omit `--app-key` / `--app-secret` if `DROPBOX_APP_KEY` and `DROPBOX_APP_SECRET` are already set in env.
- First get the auth code by opening:
  - `https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&token_access_type=offline&response_type=code`

## AI Agent MCP Setup

This project ships its own MCP server as a Supabase Edge Function at `supabase/functions/basecamp-mcp/`. Any AI agent harness (Claude Code, Cursor, Codex, etc.) can connect to it over HTTP using the Streamable HTTP transport.

### Connection details

| Field | Value |
|---|---|
| **Transport** | Streamable HTTP (`application/json`) |
| **URL** | `<SUPABASE_URL>/functions/v1/basecamp-mcp` (e.g. `https://YOUR-PROJECT.supabase.co/functions/v1/basecamp-mcp`) |
| **Auth** | `Authorization: Bearer <JWT>` — short-lived HS256 JWT (see below) |
| **Health check** | `GET <URL>/healthz` returns `200 ok` |
| **Readiness** | `GET <URL>/readyz` returns `200 ok` when DB is reachable |

### JWT authentication

The server validates every request with a signed JWT. To mint one:

```sh
node scripts/mint-mcp-jwt.mjs \
  --secret "$PM_CLIENT_JWT_SECRET" \
  --client-id "$PM_CLIENT_ID" \
  --issuer basecamp-mcp \
  --audience basecamp-mcp \
  --expires-in 900
```

Required env vars (see `.env.example`):
- `PM_CLIENT_MCP_URL` — the full function URL
- `PM_CLIENT_ID` — must match an existing row in the `agent_clients` DB table
- `PM_CLIENT_JWT_SECRET` — shared HMAC secret (same as `PM_SERVER_JWT_SECRET` on the server side)

### Available tools

The MCP server exposes these tools once connected:

**Read:** `list_projects`, `list_archived_projects`, `get_project`, `get_thread`, `list_files`, `get_file`, `search_content`, `get_my_profile`

**Write:** `create_project`, `update_project`, `create_thread`, `update_thread`, `create_comment`, `update_comment`, `create_file`, `upload_file`, `update_my_profile`

### Claude Code quick-start

```sh
# 1. Mint a JWT (prints to stdout)
TOKEN=$(node scripts/mint-mcp-jwt.mjs \
  --secret "$PM_CLIENT_JWT_SECRET" \
  --client-id "$PM_CLIENT_ID")

# 2. Register the MCP server
claude mcp add --transport http \
  --header "Authorization: Bearer $TOKEN" \
  basecamp "$PM_CLIENT_MCP_URL"

# 3. Verify
claude mcp get basecamp
```

### Other agent harnesses

For any MCP-compatible client, configure:
- **URL:** value of `PM_CLIENT_MCP_URL`
- **Header:** `Authorization: Bearer <token>` (from `mint-mcp-jwt.mjs`)
- **Transport:** HTTP (Streamable HTTP, not SSE)
