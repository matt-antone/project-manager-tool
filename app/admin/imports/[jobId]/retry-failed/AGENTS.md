<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# Retry Failed Imports

## Purpose
Retry failed records from an import job

## Key Files
| File | Description |
|------|-------------|
| `route.ts` | API endpoint. Exports: POST |

## For AI Agents

### Working In This Directory
This is an API endpoint. Uses `requireUser()` for auth gating. Returns JSON via helpers like `ok()`, `badRequest()`, `notFound()`, `unauthorized()`, `serverError()`, or `conflict()`.

## Dependencies

### Internal
- `lib/...` — utilities and shared logic

<!-- MANUAL: -->
