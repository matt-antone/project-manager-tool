<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# lib/storage/

## Purpose
Dropbox SDK adapter and storage abstraction layer. Provides unified interface for file upload, download, metadata operations, and directory management across the Dropbox backend.

## Key Files
| File | Description |
|------|-------------|
| `dropbox-adapter.ts` | Dropbox SDK wrapper with retry, error handling, path management, and batch operations (server-only) |

## For AI Agents

### Working In This Directory
- **Server-only**: All Dropbox operations require server context (credentials, tokens).
- **Async I/O**: All methods are async; expect network latency.
- **Credential management**: Dropbox token sourced from environment config.
- **Path conventions**: Paths are app-internal (`/projects/CLIENT/...`); adapter maps to Dropbox paths.

### Common Patterns
- Dropbox SDK initialization with error handling
- Exponential backoff retry on rate limit / transient errors
- Batch operations for efficiency (delete multiple files, upload multiple)
- Path normalization and validation
- Metadata preservation across operations
- Stream support for large file uploads

## Dependencies

### Internal
- `config.ts` for Dropbox token and base path
- `lib/project-storage.ts` for path resolution
- Called by attachment upload/download routes in `app/`

### External
- `dropbox` SDK — Dropbox API client
- `node:fs`, `node:path` — File system and path utilities
- `node:stream` — Stream handling for large files

<!-- MANUAL: -->
