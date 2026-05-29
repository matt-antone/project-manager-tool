<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# lib/imports/orphans/

## Purpose
Recovery tools for orphaned files and comments from failed or incomplete BC2 imports. Identifies records that were partially imported (e.g., file metadata created but attachment not linked), generates recovery plan CSV, and provides apply logic to complete or roll back orphaned records.

## Key Files
| File | Description |
|------|-------------|
| `types.ts` | Orphan classification and recovery metadata types |
| `csv.ts` | Parse orphan audit CSV; generate recovery plan from database queries |
| `apply.ts` | Execute recovery plan: link orphaned attachments, delete incomplete records, or suppress |

## For AI Agents

### Working In This Directory
- **Server-only**: Database queries and file operations.
- **CLI-driven**: Called by manual recovery scripts when import fails partway.
- **Database mutations**: Deletes or links incomplete attachment records.
- **Safety critical**: Requires explicit user approval before applying recovery plan (generated CSV is review-only first).

### Common Patterns
- Orphan classification: "file-created-unlinked", "comment-created-missing-attachment", etc.
- Recovery strategies: "link", "delete", "suppress"
- CSV-based approval workflow: generate plan CSV → user review → apply if approved
- Logging all changes for audit trail

## Dependencies

### Internal
- `lib/db.ts` — Query and update attachment/comment records
- `lib/imports/audit/` — CSV I/O and reconciliation formats
- Recovery invoked manually after import failure diagnosis

### External
- `pg` — Database access
- `node:fs` — CSV I/O

<!-- MANUAL: -->
