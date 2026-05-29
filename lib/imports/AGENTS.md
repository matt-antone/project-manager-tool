<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# lib/imports/

## Purpose
Basecamp 2 to Basecamp 3 (this app) migration pipeline. Fetches data from BC2 API, transforms to local schema, downloads attachments, resolves client/project relationships, links files to threads/comments, and tracks import state with audit trail. CLI-driven by `scripts/basecamp2-import.ts`.

## Key Files
| File | Description |
|------|-------------|
| `basecamp2-import.ts` | Main import orchestrator: job creation, payload validation, phase execution |
| `bc2-client.ts` | BC2 API HTTP client with authentication and error handling |
| `bc2-fetcher.ts` | BC2 data shapes (Person, Project, Thread, Comment, Attachment, etc.) |
| `bc2-transformer.ts` | Transform BC2 records to local schema; parse titles; resolve client IDs |
| `bc2-client-resolver.ts` | Match BC2 projects to local clients by code or name; handle auto-create |
| `bc2-title-classifier.ts` | Classify project titles into primary/secondary categories for billing |
| `bc2-attachment-download.ts` | Download attachments from BC2 to local temp storage |
| `bc2-attachment-linkage.ts` | Link downloaded attachments to threads/comments using import maps |
| `bc2-migrate-single-file.ts` | Single-file migration handler for selective re-import |
| `dump-reader.ts` | Read BC2 JSON dumps from local filesystem (alternative to API) |
| `audit/` | Audit trail and reconciliation tools (see `audit/AGENTS.md`) |
| `migration/` | Phase orchestration and state management (see `migration/AGENTS.md`) |
| `orphans/` | Recover orphaned files and comments (see `orphans/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- **Server-only**: All BC2 integration is server-side Node.js.
- **CLI-driven**: Invoked by `scripts/basecamp2-import.ts` or `scripts/audit-bc2-user-map.ts`, not from request handlers.
- **Long-running**: Import jobs are asynchronous; expect network latency and database writes.
- **Side effects**: Downloads files to disk, writes to database, calls BC2 API, uploads to Dropbox.
- **Safety critical**: Database backup is mandatory before running any import (see auto-memory `feedback_db_backup_before_migration`).
- **Never re-run full migration**: Reconciliation uses targeted subsets, never the full phase orchestration (see auto-memory `feedback_no_full_migration_rerun`).

### Common Patterns
- Zod schemas for BC2 response validation
- `pg` Pool for import state and record writes
- Exponential backoff retry on BC2 API rate limits
- Import maps (CSV) for tracking which BC2 records were imported
- Error recovery via audit CSV (see `audit/AGENTS.md`)
- Dropbox path collision resolution (see `reconcile-filenames/AGENTS.md`)

## Dependencies

### Internal
- `lib/db.ts` — Postgres Pool
- `lib/config.ts` — BC2 API credentials
- `lib/repositories.ts` — Data access layer
- `lib/storage/dropbox-adapter.ts` — File upload to Dropbox
- `lib/reconcile-filenames/` — Filename collision handling
- `lib/imports/audit/` — Reconciliation and audit trails
- `lib/imports/migration/` — Phase state management
- `supabase/migrations/` — Import-related schema changes

### External
- `pg` — Postgres client
- `dropbox` — File storage
- `zod` — Data validation
- `node:fs`, `node:https` — Local file I/O, HTTP requests
- `csv-parser`, `csv-writer` — CSV import/export (in `audit/`)

<!-- MANUAL: -->
