// OAuth 2.1 authorization server for Claude connectors (claude.ai custom connectors
// only speak OAuth + PKCE + dynamic client registration — they cannot send a
// hand-minted bearer token).
//
// Everything is stateless: registered clients, authorization codes and refresh
// tokens are HS256 JWTs signed with the same PM_SERVER_JWT_SECRET, so this adds
// no tables and no migrations. Access tokens are the existing agent JWTs, so
// authenticateAgent() is unchanged.
//
// The consent page lives in the app (MCP_AUTHORIZE_URL) because Supabase rewrites
// any text/html served from *.supabase.co to text/plain with a sandbox CSP.
import {
  base64UrlEncode,
  mintAgentJwt,
  OAUTH_CLIENT_AUDIENCE,
  OAUTH_CODE_AUDIENCE,
  signJwt,
  verifyJwt,
  type JwtAuthConfig,
} from "./auth.ts";

const encoder = new TextEncoder();
const ACCESS_TTL = 15 * 60;
const REFRESH_TTL = 30 * 24 * 3600;
const CLIENT_TTL = 10 * 365 * 24 * 3600;
const REFRESH_AUDIENCE = "oauth-refresh";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });
}

/** Public URL of this MCP server. Override with MCP_PUBLIC_URL when proxied behind another domain. */
export function publicUrl(req: Request): string {
  const env = Deno.env.get("MCP_PUBLIC_URL");
  if (env) return env.replace(/\/$/, "");
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const proto = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  const path = url.pathname.replace(/\/(\.well-known\/.*|token|register)$/, "").replace(/\/$/, "");
  // The hosted edge runtime hands the function a path without the public /functions/v1 prefix.
  const prefix = host.endsWith(".supabase.co") && !path.startsWith("/functions/v1") ? "/functions/v1" : "";
  return `${proto}://${host}${prefix}${path}`;
}

const withAudience = (config: JwtAuthConfig, audience: string): JwtAuthConfig => ({ ...config, audience });

async function mint(
  claims: Record<string, unknown>,
  config: JwtAuthConfig,
  ttlSeconds: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await signJwt(
    { ...claims, iss: config.issuer, aud: config.audience, iat: now, exp: now + ttlSeconds, jti: crypto.randomUUID() },
    config
  );
}

async function open(token: string, config: JwtAuthConfig): Promise<Record<string, unknown> | null> {
  try {
    return (await verifyJwt(token, config)) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/**
 * Handles the OAuth endpoints. Returns null when the request is not an OAuth request,
 * so the caller falls through to the MCP transport.
 */
export async function handleOAuth(req: Request, config: JwtAuthConfig): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const base = publicUrl(req);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (path.endsWith("/.well-known/oauth-protected-resource")) {
    return json({
      resource: base,
      authorization_servers: [base],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  }

  if (
    path.endsWith("/.well-known/oauth-authorization-server") ||
    path.endsWith("/.well-known/openid-configuration")
  ) {
    return json({
      issuer: base,
      authorization_endpoint: Deno.env.get("MCP_AUTHORIZE_URL") ?? `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  }

  if (path.endsWith("/register") && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { redirect_uris?: unknown };
    const redirect_uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string" && u.startsWith("https://"))
      : [];
    if (redirect_uris.length === 0) return json({ error: "invalid_redirect_uri" }, 400);
    const client_id = await mint(
      { sub: "oauth-client", redirect_uris },
      withAudience(config, OAUTH_CLIENT_AUDIENCE),
      CLIENT_TTL
    );
    return json(
      {
        client_id,
        redirect_uris,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201
    );
  }

  if (path.endsWith("/token") && req.method === "POST") return await token(req, config);

  return null;
}

async function issueTokens(agentId: string, config: JwtAuthConfig): Promise<Response> {
  return json({
    access_token: await mintAgentJwt({ client_id: agentId, expiresInSeconds: ACCESS_TTL }, config),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    scope: "mcp",
    refresh_token: await mint({ sub: agentId }, withAudience(config, REFRESH_AUDIENCE), REFRESH_TTL),
  });
}

async function token(req: Request, config: JwtAuthConfig): Promise<Response> {
  const form = new URLSearchParams([...(await req.formData())].map(([k, v]) => [k, String(v)]));
  const grant = form.get("grant_type");

  if (grant === "refresh_token") {
    const claims = await open(form.get("refresh_token") ?? "", withAudience(config, REFRESH_AUDIENCE));
    if (!claims) return json({ error: "invalid_grant" }, 400);
    return await issueTokens(String(claims.sub), config);
  }

  if (grant !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);

  const claims = await open(form.get("code") ?? "", withAudience(config, OAUTH_CODE_AUDIENCE));
  if (!claims) return json({ error: "invalid_grant" }, 400);
  if (claims.redirect_uri !== form.get("redirect_uri")) return json({ error: "invalid_grant" }, 400);

  const verifier = form.get("code_verifier") ?? "";
  if (base64UrlEncode(await sha256(verifier)) !== claims.code_challenge) {
    return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }

  return await issueTokens(String(claims.sub), config);
}
