import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  authenticateAgent,
  AuthError,
  createRateLimiter,
  ensureProfile,
  parseBearerToken,
} from "./auth.ts";
import { handleOAuth, publicUrl } from "./oauth.ts";
import { registerTools } from "./tools.ts";

const RPM_LIMIT = parseInt(Deno.env.get("MCP_RATE_LIMIT_RPM") ?? "120", 10);
const JWT_SECRET = Deno.env.get("PM_SERVER_JWT_SECRET");
const JWT_ISSUER = Deno.env.get("PM_SERVER_JWT_ISSUER") ?? "basecamp-mcp";
const JWT_AUDIENCE = Deno.env.get("PM_SERVER_JWT_AUDIENCE") ?? "basecamp-mcp";
const JWT_CLOCK_TOLERANCE_SECONDS = parseInt(Deno.env.get("PM_SERVER_JWT_CLOCK_TOLERANCE_SECONDS") ?? "30", 10);

function getSupabaseClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey);
}

// Module-level singleton — shared across requests in the same isolate
const rateLimiter = createRateLimiter(RPM_LIMIT);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/healthz")) {
    return new Response("ok", { status: 200, headers: SECURITY_HEADERS });
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return new Response("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", {
      status: 503,
      headers: SECURITY_HEADERS,
    });
  }

  if (!JWT_SECRET) {
    return new Response("Missing PM_SERVER_JWT_SECRET", { status: 503, headers: SECURITY_HEADERS });
  }

  const jwtConfig = {
    secret: JWT_SECRET,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    clockToleranceSeconds: JWT_CLOCK_TOLERANCE_SECONDS,
  };

  const oauthResponse = await handleOAuth(req, jwtConfig);
  if (oauthResponse) return oauthResponse;

  if (url.pathname.endsWith("/readyz")) {
    const { error } = await supabase.from("agent_clients").select("client_id").limit(1);
    if (error) return new Response("unavailable", { status: 503, headers: SECURITY_HEADERS });
    return new Response("ok", { status: 200, headers: SECURITY_HEADERS });
  }

  const token = parseBearerToken(req.headers.get("authorization"));

  let agent;
  try {
    agent = await authenticateAgent(supabase, token, jwtConfig);
  } catch (e) {
    if (e instanceof AuthError) {
      // RFC 9728: point OAuth clients (Claude connectors) at the resource metadata.
      const headers = e.status === 401
        ? {
          ...SECURITY_HEADERS,
          "WWW-Authenticate":
            `Bearer resource_metadata="${publicUrl(req)}/.well-known/oauth-protected-resource"`,
        }
        : SECURITY_HEADERS;
      return new Response(e.message, { status: e.status, headers });
    }
    return new Response("Internal error", { status: 500, headers: SECURITY_HEADERS });
  }

  if (!rateLimiter.consume(agent.client_id)) {
    return new Response("Too many requests", {
      status: 429,
      headers: { ...SECURITY_HEADERS, "Retry-After": "60" },
    });
  }

  try {
    await ensureProfile(supabase, agent.client_id);

    const server = new McpServer({ name: "basecamp-mcp", version: "2.0.0" });
    registerTools(server, supabase, agent);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (error) {
    console.error("basecamp-mcp request handling failed", {
      client_id: agent.client_id,
      method: req.method,
      pathname: url.pathname,
      error,
    });
    return new Response("Internal error", { status: 500, headers: SECURITY_HEADERS });
  }
});
