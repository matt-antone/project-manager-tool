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
| oauth.ts | OAuth 2.1 authorization server (discovery, DCR, /token) for Claude connectors |
| tools.ts | Tool definitions (query, read, mutate operations) exposed via MCP protocol |
| db.ts | Database queries (Supabase client with service role) |
| notify.ts | Notification helpers (e.g., Slack, email) for agent actions |
| dropbox.ts | Dropbox API integration for file operations |
| deno.json | Deno imports (MCP SDK, Supabase JS SDK) |

## For AI Agents

### Working In This Directory
- **Entrypoint:** `index.ts` (Deno.serve listening for MCP requests).
- **Deploy:** `supabase functions deploy basecamp-mcp --project-ref <ref>` (remote) or test locally via `supabase start`.
- **Authentication required:** Each MCP request must include a valid agent JWT in the `Authorization: Bearer` header.
- **Claude connectors:** claude.ai speaks OAuth only. `oauth.ts` serves `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, `/register`, `/token`. Registered clients, auth codes and refresh tokens are stateless JWTs (no tables). The consent page is `app/mcp/authorize/route.ts` in the Next app — Supabase rewrites any `text/html` served from `*.supabase.co` to `text/plain` with a sandbox CSP, so it cannot live here. Both sides sign with the same `PM_SERVER_JWT_SECRET`.
- **Rate limiting:** Default 120 requests/minute per authenticated client; configurable via `MCP_RATE_LIMIT_RPM` env var.
- **Environment variables:** Set via `supabase secrets set` (remote) or `.env.local` (local dev).
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase client setup)
  - `PM_SERVER_JWT_SECRET`, `PM_SERVER_JWT_ISSUER`, `PM_SERVER_JWT_AUDIENCE`, `PM_SERVER_JWT_CLOCK_TOLERANCE_SECONDS` (JWT config)
  - `MCP_RATE_LIMIT_RPM` (rate limiting)
  - `MCP_AUTHORIZE_URL` (the app's consent page, e.g. `https://<app>/mcp/authorize`), `MCP_PUBLIC_URL` (only if the function is proxied behind another domain)
  - App-side (Netlify), not function-side: `MCP_OAUTH_PASSWORD` (connector login), `MCP_OAUTH_CLIENT_ID` (agent_clients row the connector acts as; default `claude-connector`), plus a `PM_SERVER_JWT_SECRET` matching this function's
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
