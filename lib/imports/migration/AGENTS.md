<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# lib/imports/migration/

## Purpose
Phase orchestration and state management for multi-step BC2 import pipeline. Coordinates sequential execution of data fetch, transform, validate, and link phases; persists import job state; tracks progress and errors for resumption or rollback.

## Key Files
| File | Description |
|------|-------------|
| Phase modules | Individual phase implementations (e.g., `fetch.ts`, `transform.ts`, `link-attachments.ts`) |
| State management | Persist import job state (progress, errors, resume points) to database |
| Orchestrator | Sequential phase execution with error handling and rollback |

## For AI Agents

### Working In This Directory
- **Server-only**: All state management and phase execution.
- **CLI-driven**: Called by `scripts/basecamp2-import.ts` with job ID and payload.
- **Database mutations**: Persists job state, import maps, and reconciliation metadata.
- **Side effects**: Each phase has side effects (API calls, file I/O, database writes).
- **Safety critical**: Never re-run full orchestration on the same job ID; use targeted phase replay for recovery (see auto-memory `feedback_no_full_migration_rerun`).

### Common Patterns
- Job state: `pending` → `running` → `completed` or `failed`
- Resume points: track which phases have completed; allow selective re-run
- Error accumulation: collect errors per phase; export to audit CSV
- Transactional semantics: all-or-nothing per phase (rollback on error)
- Idempotency: phases designed to be re-runnable without duplication

## Dependencies

### Internal
- `lib/db.ts` — Job state persistence
- `lib/imports/` parent modules for phase logic
- `lib/imports/audit/` for error tracking
- Orchestrated by `scripts/basecamp2-import.ts`

### External
- `pg` — Job state reads/writes

<!-- MANUAL: -->
