<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# Project Detail API

## Purpose
Single project operations (read, update)

## Key Files
| File | Description |
|------|-------------|
| `route.ts` | API endpoint. Exports: GET, PATCH |

## Subdirectories
| Directory | Purpose |
|-----------|----------|
| `archive/` | Archive a project |
| `archived-hours/` | Retrieve hours from archived entries |
| `expense-lines/` | Project expense management (list, create) |
| `files/` | File management (list, upload handling) |
| `folder-link/` | Generate/manage folder sharing links |
| `members/` | Project team management (list, add) |
| `my-hours/` | Current user's hours for project |
| `restore/` | Restore an archived project |
| `status/` | Update project status (active, completed, on-hold) |
| `threads/` | Project discussion threads (list, create) |
| `updated-date/` | Update project last-modified timestamp |

## For AI Agents

### Working In This Directory
This is an API endpoint. Uses `requireUser()` for auth gating. Returns JSON via helpers like `ok()`, `badRequest()`, `notFound()`, `unauthorized()`, `serverError()`, or `conflict()`.

## Dependencies

### Internal
- `lib/...` — utilities and shared logic

<!-- MANUAL: -->
