<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# basecamp-clone

## Purpose
Next.js + Supabase + Dropbox project-management app modeled after Basecamp. Provides authenticated UI for projects, discussions, comments, files (Dropbox-backed), clients, billing reporting, and Basecamp 2 import tooling. Deployed to Netlify; data lives in Supabase Postgres; project files live in Dropbox.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Dependencies and pnpm scripts (`dev`, `build`, `test`, sync/migration tooling) |
| `tsconfig.json` | TypeScript config (strict, App Router paths) |
| `next.config.mjs` | Next.js config (Turbopack dev, build settings) |
| `next-env.d.ts` | Next.js generated TS env (do not edit) |
| `vitest.config.ts` | Vitest unit test config |
| `netlify.toml` | Netlify build + redirect config (production deploy target) |
| `pnpm-lock.yaml` | Locked dependency tree (pnpm@10.32.1) |
| `README.md` | Setup, env vars, run instructions |
| `plan.md`, `context.md`, `CONEXT-MODE.md` | Working planning notes |
| `skills-lock.json` | Local skills tracking |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `app/` | Next.js App Router — pages, layouts, API route handlers (see `app/AGENTS.md`) |
| `components/` | React UI components grouped by feature (see `components/AGENTS.md`) |
| `lib/` | Server-side logic: db, auth, dropbox, imports, sync, types (see `lib/AGENTS.md`) |
| `supabase/` | Postgres migrations + edge functions (see `supabase/AGENTS.md`) |
| `docs/` | Project documentation, plans, specs, handoffs (see `docs/AGENTS.md`) |
| `skills/` | Local Claude Code skills (see `skills/AGENTS.md`) |
| `scripts/` | One-shot CLI utilities for migrations/audits (not documented per deepinit scope) |
| `tests/` | Vitest unit/integration tests (not documented per deepinit scope) |
| `public/` | Static assets served by Next.js |
| `backups/`, `certificates/`, `tmp/`, `orchestration/`, `.worktrees/` | Local working state — do not commit/edit casually |

## For AI Agents

### Working In This Directory
- Package manager is **pnpm** — use `pnpm install`, `pnpm <script>`, never npm/yarn at root.
- Deployments run on **Netlify** (not Vercel); use `netlify` CLI for env/logs.
- Database backups are mandatory before any migration or destructive DB change (see auto-memory `feedback_db_backup_before_migration`).
- Never re-run the full BC2 migration — reconciliation must use targeted subsets (see auto-memory `feedback_no_full_migration_rerun`).
- Date semantics: always store absolute dates; this project frequently references prod-to-test sync state.

### Testing Requirements
- `pnpm test` runs Vitest.
- `pnpm lint` runs `next lint`.
- `pnpm build` must succeed before pushing to staging/main.

### Common Patterns
- Server-only code uses `import 'server-only'`.
- Auth-protected API handlers return JSON; UI uses `authedJsonFetch` helper.
- Project identity is `CLIENTCODE-XXXX-Title`; Dropbox path is `/projects/<CLIENTCODE>/<PROJECT_CODE>-<title>/uploads`.
- Zod for request validation; `pg` Pool for direct Postgres; `@supabase/supabase-js` for storage/auth.

## Dependencies

### External
- `next` 15 (App Router, Turbopack dev) + `react` 19
- `@supabase/supabase-js` 2 — auth + storage
- `pg` — direct Postgres for server queries
- `dropbox` — file storage backend
- `zod` — runtime validation
- `marked` + `sanitize-html` — markdown rendering
- `vitest`, `@testing-library/react`, `jsdom` — testing

### Internal layout
- `app/` calls into `lib/` for db, auth, dropbox, business logic.
- `components/` is pure UI; calls Next.js routes via fetch.
- `lib/imports/` and `lib/sync/` are CLI-driven (via `scripts/`); not invoked from request paths.

<!-- MANUAL: Custom notes preserved across regeneration go below this line -->
