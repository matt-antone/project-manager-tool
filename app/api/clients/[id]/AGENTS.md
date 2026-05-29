<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# Client Detail API

## Purpose
Single client operations (read, update)

## Key Files
| File | Description |
|------|-------------|
| `route.ts` | API endpoint. Exports: GET, PATCH |

## Subdirectories
| Directory | Purpose |
|-----------|----------|
| `archive/` | Archive a client and associated projects |
| `projects/` | List projects for a specific client |
| `restore/` | Restore an archived client |

## For AI Agents

### Working In This Directory
This is an API endpoint. Uses `requireUser()` for auth gating. Returns JSON via helpers like `ok()`, `badRequest()`, `notFound()`, `unauthorized()`, `serverError()`, or `conflict()`.

## Dependencies

### Internal
- `lib/...` — utilities and shared logic

<!-- MANUAL: -->
