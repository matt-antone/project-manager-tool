<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# Thread Detail API

## Purpose
Single thread operations (read, update, delete)

## Key Files
| File | Description |
|------|-------------|
| `route.ts` | API endpoint. Exports: DELETE, GET, PATCH |

## Subdirectories
| Directory | Purpose |
|-----------|----------|
| `comments/` | Thread comments (list, create) |

## For AI Agents

### Working In This Directory
This is an API endpoint. Uses `requireUser()` for auth gating. Returns JSON via helpers like `ok()`, `badRequest()`, `notFound()`, `unauthorized()`, `serverError()`, or `conflict()`.

## Dependencies

### Internal
- `lib/...` — utilities and shared logic

<!-- MANUAL: -->
