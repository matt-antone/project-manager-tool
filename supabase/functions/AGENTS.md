<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# functions/

## Purpose
Supabase Edge Functions (Deno-based serverless functions). Currently hosts the basecamp-mcp function, which implements a Model Context Protocol (MCP) server for agent integration. Functions are deployed to Supabase and invoked via HTTPS.

## Key Files
| File | Description |
|------|-------------|
| basecamp-mcp/ | MCP server Edge Function with authentication, tools, DB access |
| tsconfig.json | TypeScript configuration for all functions |

## For AI Agents

### Working In This Directory
- **Edge Functions run on Deno.** Syntax is TypeScript compiled to JavaScript.
- **Deploy via Supabase CLI:** `supabase functions deploy basecamp-mcp --project-ref <ref>` (remote) or local via `supabase start` (dev).
- **Environment variables** are set via `supabase secrets set KEY=value` (remote) or `.env.local` (local dev).
- **Authentication:** basecamp-mcp requires JWT or MCP client credentials; see basecamp-mcp/AGENTS.md for details.
- **Rate limiting:** Configured per function via `MCP_RATE_LIMIT_RPM` (default 120 requests/minute).

### Common Patterns
- **Streaming responses:** Use Deno's web-standard `ReadableStream` for MCP protocol streams.
- **Supabase client:** Instantiated per-request using `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- **Security headers:** Always return `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`.
- **Health checks:** Each function exposes `/healthz` endpoint returning `ok`.

## Dependencies
- Deno runtime (Supabase Edge Function platform)
- Supabase CLI (`supabase functions deploy`)
- MCP SDK (`@modelcontextprotocol/sdk`)
- Supabase JS SDK (`@supabase/supabase-js`)

<!-- MANUAL: -->
