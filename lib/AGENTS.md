<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# lib/

## Purpose
Server-side business logic shared across the app. Contains database access patterns, authentication, file storage adapters, Dropbox integration, data import/sync pipelines, type definitions, and utility functions for projects, clients, comments, and billing.

## Key Files
| File | Description |
|------|-------------|
| `db.ts` | Postgres Pool initialization; query helper with result mapping |
| `supabase-admin.ts` | Supabase Admin Client for privileged auth/storage operations |
| `auth.ts` | Session validation and token handling (server-only) |
| `server-auth.ts` | Auth context extraction from request headers (server-only) |
| `config.ts` | Environment variable loading and validation |
| `repositories.ts` | Data access layer for projects, threads, comments, files |
| `project-storage.ts` | Dropbox storage paths and URL resolution for projects |
| `project-utils.ts` | Project-related helpers: filtering, status, financials |
| `clients-filter.ts` | Client list filtering and sorting |
| `billing-stage-count.ts` | Billing stage aggregation and reporting |
| `featured-feed.ts` | Query builder for recent activity feed |
| `markdown.ts` | Markdown rendering with sanitization |
| `attachment-upload.ts` | File upload handler for Dropbox |
| `mailer.ts` | Email dispatch (NotionMail or equivalent) |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `imports/` | Basecamp 2 migration pipeline: API fetch, transform, link, audit (see `imports/AGENTS.md`) |
| `imports/audit/` | Audit trail and diff tools for import reconciliation (see `imports/audit/AGENTS.md`) |
| `imports/migration/` | Phase orchestration for multi-step BC2 import (see `imports/migration/AGENTS.md`) |
| `imports/orphans/` | Recover orphaned files and comments from failed imports (see `imports/orphans/AGENTS.md`) |
| `sync/prod-to-test/` | Prod-to-test sync engine for QA and testing (see `sync/prod-to-test/AGENTS.md`) |
| `sync/prod-to-test/phases/` | Per-entity sync phases (users, clients, projects, etc.) (see `sync/prod-to-test/phases/AGENTS.md`) |
| `types/` | Shared type definitions (see `types/AGENTS.md`) |
| `storage/` | Dropbox adapter and storage backend (see `storage/AGENTS.md`) |
| `reconcile-filenames/` | File rename and attachment reconciliation (see `reconcile-filenames/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- **Server-only**: All modules in `lib/` are server-side Node.js code; may use `import 'server-only'` to guard against accidental client imports.
- **Database access**: Direct `pg` Pool usage or Supabase Admin Client for all data operations.
- **Side effects**: File downloads from Dropbox, email dispatch, database migrations.
- **CLI-driven pipelines**: `lib/imports/` and `lib/sync/` are invoked by CLI scripts (see `scripts/sync-prod-to-test.ts`, `scripts/basecamp2-import.ts`), not from request handlers.
- **Safety critical**: Import and sync operations require database backups before execution (see auto-memory).

### Common Patterns
- `server-only` guard for modules unsafe on client
- Zod schemas for request/response validation
- `pg` Pool for direct SQL queries with parameterized statements
- Dropbox SDK for file I/O
- Supabase Admin Client for auth token generation and storage access
- Error types: custom Error subclasses with context
- Retry logic: exponential backoff for network calls

## Dependencies

### Internal
- `app/` calls into `lib/` for all db, auth, dropbox, and business logic.
- `components/` is pure UI; communicates via Next.js API routes.
- Database schema lives in `supabase/migrations/`.

### External
- `pg` — Postgres client for direct queries
- `@supabase/supabase-js` — Supabase Admin SDK
- `dropbox` — Dropbox SDK for file storage
- `zod` — Runtime validation
- `marked`, `sanitize-html` — Markdown rendering
- `nodemailer` or equivalent — Email dispatch
- `node:crypto`, `node:fs`, `node:path` — Node.js builtins

<!-- MANUAL: -->
