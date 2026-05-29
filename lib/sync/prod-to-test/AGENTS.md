<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# lib/sync/prod-to-test/

## Purpose
Production-to-test database sync engine. Mirrors production data (users, clients, projects, threads, comments, files) to test dataset for QA and local testing. Coordinates per-entity sync phases, manages watermarks for incremental sync, performs safety checks, backs up test DB before each run, and handles ID remapping between prod and test.

## Key Files
| File | Description |
|------|-------------|
| `context.ts` | Build sync context: Postgres and Supabase client connections, environment validation |
| `safety.ts` | Pre-sync safety checks: verify target is test DB, no prod credentials, backup availability |
| `backup.ts` | Backup test DB before sync; restore on rollback (pg_dump + gzip) |
| `watermarks.ts` | Track last-synced timestamps per entity; enable incremental re-sync |
| `phases/` | Per-entity sync phases (see `phases/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- **Server-only**: All database operations require server context.
- **CLI-driven**: Invoked by `scripts/sync-prod-to-test.ts`; not from request handlers.
- **Destructive**: Overwrites test DB; requires confirmation and backup before execution.
- **Side effects**: Drops and recreates test DB tables, downloads files from Dropbox.
- **Safety critical**: Database backup is mandatory before any sync (see auto-memory `feedback_db_backup_before_migration`).
- **Incremental**: Watermarks allow selective sync of recently-changed records; full sync also available.

### Common Patterns
- Environment validation: `assertEnvSafe()` prevents accidental prod-to-prod or test data loss
- Dual connections: `pg` Pool for direct SQL, Supabase Admin for auth + file ops
- Backup before write: always backup test DB before dropping/recreating tables
- Watermark tracking: JSON file stores last synced timestamp per entity
- Phase orchestration: run phases in order (users → clients → projects → threads → comments → files)
- ID mapping: remap user/client/project IDs from prod to test space

## Dependencies

### Internal
- `lib/db.ts` — Postgres Pool initialization
- `lib/supabase-admin.ts` — Supabase Admin Client
- `lib/config.ts` — Environment variables (database URLs, credentials)
- `lib/sync/prod-to-test/phases/` — Per-entity sync logic
- Called by `scripts/sync-prod-to-test.ts`

### External
- `pg` — Postgres client for direct SQL
- `@supabase/supabase-js` — Admin Client for storage ops
- `node:child_process` — `pg_dump` for backups
- `node:fs`, `node:path` — File I/O for watermarks and backups

<!-- MANUAL: -->
