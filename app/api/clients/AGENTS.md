<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# Clients API

## Purpose
Client CRUD operations (list, create)

## Key Files
| File | Description |
|------|-------------|
| `route.ts` | API endpoint. Exports: GET, POST |

## Subdirectories
| Directory | Purpose |
|-----------|----------|
| `[id]/` | Single client operations (read, update) |

## For AI Agents

### Working In This Directory
This is an API endpoint. Uses `requireUser()` for auth gating. Returns JSON via helpers like `ok()`, `badRequest()`, `notFound()`, `unauthorized()`, `serverError()`, or `conflict()`.

## Dependencies

### Internal
- `lib/...` — utilities and shared logic

<!-- MANUAL: -->
