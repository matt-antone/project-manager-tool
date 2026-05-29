<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# Comments API

## Purpose
Thread comments (list, create)

## Key Files
| File | Description |
|------|-------------|
| `route.ts` | API endpoint. Exports: POST |

## Subdirectories
| Directory | Purpose |
|-----------|----------|
| `[commentId]/` | Single comment operations |

## For AI Agents

### Working In This Directory
This is an API endpoint. Uses `requireUser()` for auth gating. Returns JSON via helpers like `ok()`, `badRequest()`, `notFound()`, `unauthorized()`, `serverError()`, or `conflict()`.

## Dependencies

### Internal
- `lib/...` — utilities and shared logic

<!-- MANUAL: -->
