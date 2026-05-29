<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# lib/reconcile-filenames/

## Purpose
File attachment reconciliation and renaming logic. Handles filename collision detection, sanitization, renaming strategies, and Dropbox path updates after filename changes or import conflicts.

## Key Files
| File | Description |
|------|-------------|
| Reconciliation strategy modules | Filename collision resolution (rename, replace, skip) |
| Dropbox syncing | Update attachment metadata after Dropbox path changes |
| Sanitization | Safe filename generation from raw user input |
| Audit trail | Log all filename changes for reconciliation audit |

## For AI Agents

### Working In This Directory
- **Server-only**: All file operations require server context.
- **Database mutations**: Updates attachment records after Dropbox operations.
- **Side effects**: Dropbox API calls to rename/move files.
- **Data integrity**: Ensures filename uniqueness per project and consistent path references.

### Common Patterns
- Collision detection by filename hash in project directory
- Rename generation with numeric suffix (e.g., `file.pdf` → `file-2.pdf`)
- Sanitization: strip special chars, enforce length limits
- Transaction-like behavior: log first, then apply to Dropbox
- Rollback support for failed sync

## Dependencies

### Internal
- `lib/storage/dropbox-adapter.ts` for Dropbox operations
- `lib/project-storage.ts` for path resolution
- Database write access for attachment updates
- Called by BC2 import pipeline to reconcile filename collisions

### External
- `dropbox` SDK — file operations
- `pg` — attachment record updates

<!-- MANUAL: -->
