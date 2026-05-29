<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# lib/sync/prod-to-test/phases/

## Purpose
Per-entity sync phase implementations. Each module syncs one entity type from prod to test, handling ID remapping, relationship resolution, and incremental watermark updates. Phases are executed in order: users → clients → projects → threads → comments → files.

## Key Files
| File | Description |
|------|-------------|
| `types.ts` | Phase context types (PhaseCtx, PhaseResult, PhaseError) and CLI flags |
| `users.ts` | Sync users from prod to test; remap user IDs; track watermark |
| `clients.ts` | Sync clients from prod to test; preserve relationships to users |
| `projects.ts` | Sync projects from prod to test; remap project IDs and client refs |
| `threads.ts` | Sync discussion threads from prod to test; resolve user/project refs |
| `comments.ts` | Sync discussion comments from prod to test; resolve user/thread refs |
| `files.ts` | Sync file metadata from prod to test; download attachments from Dropbox |
| `user-ref.ts` | Resolve user ID mappings across prod/test spaces (central mapping utility) |

## For AI Agents

### Working In This Directory
- **Server-only**: All database operations and file I/O.
- **CLI-driven**: Each phase function called sequentially by `scripts/sync-prod-to-test.ts`.
- **Database mutations**: Insert/update rows in test DB tables.
- **Side effects**: Download files from Dropbox (files phase only).
- **ID remapping**: All phases use user-ref utility to remap foreign keys from prod to test space.

### Common Patterns
- Phase signature: `async function runXxxPhase(ctx: PhaseCtx): Promise<PhaseResult>`
- Refresh variant: `runXxxPhaseRefresh(ctx)` clears table first, then re-syncs all records
- Watermark updates: after phase completes, save last-synced timestamp
- Error handling: collect errors per record; return summary (X inserted, Y updated, Z failed)
- ID mapping: pass prod ID through `resolveUserRef()` or similar to get test ID
- Incremental logic: WHERE clause filters by `updated_at > last_watermark`

## Dependencies

### Internal
- `lib/db.ts` — Postgres Pool for test DB writes
- `lib/supabase-admin.ts` — File downloads from Dropbox
- `lib/sync/prod-to-test/watermarks.ts` — Save/load watermark timestamps
- Parent sync engine (`lib/sync/prod-to-test/`) for orchestration

### External
- `pg` — Postgres client
- `dropbox` — File storage backend (files phase)
- `node:crypto` — UUID generation

<!-- MANUAL: -->
