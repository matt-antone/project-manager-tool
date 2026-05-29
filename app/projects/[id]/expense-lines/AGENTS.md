<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# Expense Lines API

## Purpose
Project expense management (list, create)

## Key Files
| File | Description |
|------|-------------|
| `route.ts` | API endpoint. Exports: GET, POST |

## Subdirectories
| Directory | Purpose |
|-----------|----------|
| `[lineId]/` | Single expense line operations |

## For AI Agents

### Working In This Directory
This is an API endpoint. Uses `requireUser()` for auth gating. Returns JSON via helpers like `ok()`, `badRequest()`, `notFound()`, `unauthorized()`, `serverError()`, or `conflict()`.

## Dependencies

### Internal
- `lib/...` — utilities and shared logic

<!-- MANUAL: -->
