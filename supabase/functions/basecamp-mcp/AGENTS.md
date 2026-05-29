<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# basecamp-mcp/

## Purpose
Supabase Edge Function implementing a Model Context Protocol (MCP) server. Provides authenticated access to project management tools: querying projects/clients, reading files, posting comments, managing project members, and creating expense lines. Handles JWT authentication, MCP client credential verification, and rate limiting.

## Key Files
| File | Description |
|------|-------------|
| index.ts | MCP server entrypoint; request routing, health checks, rate limiting |
| auth.ts | JWT and MCP client authentication; bearer token parsing; rate limiter |
| tools.ts | Tool definitions (query, read, mutate operations) exposed via MCP protocol |
| db.ts | Database queries (Supabase client with service role) |
| notify.ts | Notification helpers (e.g., Slack, email) for agent actions |
| dropbox.ts | Dropbox API integration for file operations |
| deno.json | Deno imports (MCP SDK, Supabase JS SDK) |

## For AI Agents

### Working In This Directory
- **Entrypoint:** `index.ts` (Deno.serve listening for MCP requests).
- **Deploy:** `supabase functions deploy basecamp-mcp --project-ref <ref>` (remote) or test locally via `supabase start`.
- **Authentication required:** Each MCP request must include either a valid JWT or MCP client ID + secret in Authorization header.
- **Rate limiting:** Default 120 requests/minute per authenticated client; configurable via `MCP_RATE_LIMIT_RPM` env var.
- **Environment variables:** Set via `supabase secrets set` (remote) or `.env.local` (local dev).
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase client setup)
  - `PM_SERVER_JWT_SECRET`, `PM_SERVER_JWT_ISSUER`, `PM_SERVER_JWT_AUDIENCE`, `PM_SERVER_JWT_CLOCK_TOLERANCE_SECONDS` (JWT config)
  - `MCP_RATE_LIMIT_RPM` (rate limiting)
  - `DROPBOX_ACCESS_TOKEN`, `SLACK_WEBHOOK_URL` (optional integrations)

### Common Patterns
- **MCP transport:** WebStandardStreamableHTTPServerTransport handles streaming JSON-RPC over HTTP.
- **Tool execution:** Each tool maps to one or more database operations (query via GROQ-like patterns or direct SQL).
- **Error handling:** Auth errors return 401; validation/DB errors return 400 or 500.
- **Idempotency:** MCP client ID and request context ensure tools can be safely retried.
- **Logging:** Errors logged to stderr; health checks and metrics available via `/healthz`.

## Dependencies
- Deno (runtime; standard library)
- `@modelcontextprotocol/sdk` (MCP protocol implementation)
- `@supabase/supabase-js` (database client)
- Dropbox API SDK (optional; for file operations)

<!-- MANUAL: -->
