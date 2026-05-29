<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# Google OAuth Callback

## Purpose
OAuth callback handler (GET and POST)

## Key Files
| File | Description |
|------|-------------|
| `route.ts` | API endpoint. Exports: GET, POST |

## For AI Agents

### Working In This Directory
This is an API endpoint. Uses `requireUser()` for auth gating. Returns JSON via helpers like `ok()`, `badRequest()`, `notFound()`, `unauthorized()`, `serverError()`, or `conflict()`.

## Dependencies

### Internal
- `lib/...` — utilities and shared logic

<!-- MANUAL: -->
