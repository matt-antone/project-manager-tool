<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# Files API

## Purpose
File management (list, upload handling)

## Key Files
| File | Description |
|------|-------------|
| `route.ts` | API endpoint. Exports: GET |

## Subdirectories
| Directory | Purpose |
|-----------|----------|
| `[fileId]/` | Individual file operations |
| `upload-complete/` | Handle multipart upload completion |
| `upload-init/` | Initialize multipart file upload |

## For AI Agents

### Working In This Directory
This is an API endpoint. Uses `requireUser()` for auth gating. Returns JSON via helpers like `ok()`, `badRequest()`, `notFound()`, `unauthorized()`, `serverError()`, or `conflict()`.

## Dependencies

### Internal
- `lib/...` — utilities and shared logic

<!-- MANUAL: -->
