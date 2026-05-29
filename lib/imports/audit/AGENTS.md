<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# lib/imports/audit/

## Purpose
Audit trail and reconciliation tools for BC2 import verification. Tracks pre-import and post-import state, compares expected vs. actual records, generates diffs, and exports results to CSV for manual review and recovery planning.

## Key Files
| File | Description |
|------|-------------|
| `types.ts` | Entity kinds (people, projects, topics, comments, files) and row classification types |
| `reader.ts` | Read audit CSV files from disk; parse classified rows and state snapshots |
| `csv-writer.ts` | Write audit results to CSV with proper escaping and formatting |
| `diff.ts` | Compare pre/post-import state; identify missing, extra, or modified records |

## For AI Agents

### Working In This Directory
- **Server-only**: File I/O and database operations.
- **CLI-driven**: Called by audit scripts (`scripts/audit-bc2-user-map.ts`, etc.).
- **No side effects**: Read-only analysis by default; CSV write is output-only.
- **Data format**: CSV with headers: `entity_kind`, `id`, `status`, `error_message`, etc.

### Common Patterns
- Entity kinds: "people", "projects", "topics", "comments", "files"
- Row classifications: "matched", "missing", "extra", "error"
- Pre/post snapshots: store counts per entity kind before/after import
- Diff generation: compare snapshots to identify reconciliation targets

## Dependencies

### Internal
- `lib/db.ts` — Query import state and record counts
- Audit CSV files stored in `tmp/audit/*.csv` (per auto-memory reference)

### External
- `node:fs`, `node:path` — File I/O
- `csv-parser` — CSV reading (if used)

<!-- MANUAL: -->
