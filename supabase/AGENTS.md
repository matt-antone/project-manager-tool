<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# supabase/

## Purpose
Supabase database schema (migrations), Edge Functions, and configuration. The schema defines projects, clients, files, comments, users, and BC2 reconciliation artifacts. Edge Functions expose a managed MCP server for agent integration. Migrations are applied sequentially and forward-only.

## Key Files
| File | Description |
|------|-------------|
| migrations/ | SQL schema migrations (numbered 0001–0031) |
| functions/basecamp-mcp/ | Supabase Edge Function: MCP server for agent tooling |
| functions/tsconfig.json | TypeScript configuration for Edge Functions |

## For AI Agents

### Working In This Directory
- **Migrations are forward-only.** Never re-run full BC2 migration; use targeted subsets only (see project memory).
- **Backup database before applying any migration** (verified prerequisite for any DB change in any env).
- **Deploy via Supabase CLI:** `supabase db push` (local dev) or `supabase db remote set prod` + push (remote).
- **No RLS policies on core tables** (`clients`, `projects`); server routes use the database pool (service role).
- Edge Functions are deployed via `supabase functions deploy basecamp-mcp`.

### Common Patterns
- **Idempotent migrations:** Use `if not exists` and `drop constraint if exists` to tolerate re-runs on different envs.
- **BC2 import maps:** `import_map_people`, `import_map_projects`, etc. track Basecamp 2 → local ID mappings for reconciliation.
- **Full-text search (FTS):** `projects_search_fts` index on `(name, pm_note)` for workspace search.
- **Agent clients table:** `agent_clients` stores MCP client credentials (replaces `MCP_CLIENTS_JSON` env var).

## Dependencies
- Supabase CLI (local development and remote deploy)
- Deno runtime (Edge Functions)
- MCP SDK (`@modelcontextprotocol/sdk`)

<!-- MANUAL: -->
