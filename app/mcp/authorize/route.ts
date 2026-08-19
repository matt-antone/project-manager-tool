// OAuth consent page for the Claude connector.
//
// This lives in the app, not in the edge function, because Supabase rewrites any
// text/html served from *.supabase.co to text/plain with a sandbox CSP. The function
// advertises this URL as its authorization_endpoint and mints nothing here except the
// authorization code, signed with the same PM_SERVER_JWT_SECRET it verifies at /token.
import { NextRequest, NextResponse } from "next/server";
import {
  OAUTH_CLIENT_AUDIENCE,
  OAUTH_CODE_AUDIENCE,
  OAUTH_CODE_TTL_SECONDS,
  signJwt,
  timingSafeEqual,
  verifyJwt,
  type JwtAuthConfig,
} from "@/supabase/functions/basecamp-mcp/auth";

function jwtConfig(audience: string): JwtAuthConfig {
  const secret = process.env.PM_SERVER_JWT_SECRET;
  if (!secret) throw new Error("PM_SERVER_JWT_SECRET is not set");
  return { secret, issuer: process.env.PM_SERVER_JWT_ISSUER ?? "basecamp-mcp", audience };
}

interface AuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
}

async function parse(params: URLSearchParams): Promise<AuthorizeRequest | string> {
  const client_id = params.get("client_id") ?? "";
  const redirect_uri = params.get("redirect_uri") ?? "";
  const code_challenge = params.get("code_challenge") ?? "";

  let registered: unknown;
  try {
    const claims = await verifyJwt(client_id, jwtConfig(OAUTH_CLIENT_AUDIENCE));
    registered = (claims as unknown as Record<string, unknown>).redirect_uris;
  } catch {
    return "Unknown client";
  }
  if (!Array.isArray(registered) || !registered.includes(redirect_uri)) return "Unregistered redirect_uri";
  if (params.get("response_type") !== "code") return "response_type must be code";
  if (!code_challenge || params.get("code_challenge_method") !== "S256") return "PKCE S256 is required";

  return { client_id, redirect_uri, code_challenge, state: params.get("state") ?? "" };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

function loginPage(request: AuthorizeRequest, error?: string): NextResponse {
  const hidden = Object.entries({ ...request, response_type: "code", code_challenge_method: "S256" })
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  return new NextResponse(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Claude to PM Relay</title>
<style>body{font-family:system-ui;max-width:22rem;margin:15vh auto;padding:0 1rem}
input,button{width:100%;padding:.6rem;margin:.35rem 0;font-size:1rem;box-sizing:border-box}
p.err{color:#b00}</style>
<h1>Connect Claude to PM Relay</h1>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post"><input type="password" name="password" placeholder="Access password" autofocus required>
${hidden}<button type="submit">Allow access</button></form></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function GET(request: NextRequest) {
  const parsed = await parse(request.nextUrl.searchParams);
  if (typeof parsed === "string") return new NextResponse(parsed, { status: 400 });
  return loginPage(parsed);
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const params = new URLSearchParams([...form].map(([k, v]) => [k, String(v)]));
  const parsed = await parse(params);
  if (typeof parsed === "string") return new NextResponse(parsed, { status: 400 });

  const expected = process.env.MCP_OAUTH_PASSWORD;
  if (!expected) return new NextResponse("MCP_OAUTH_PASSWORD is not set", { status: 503 });
  if (!timingSafeEqual(await sha256(params.get("password") ?? ""), await sha256(expected))) {
    return loginPage(parsed, "Incorrect password");
  }

  const now = Math.floor(Date.now() / 1000);
  const config = jwtConfig(OAUTH_CODE_AUDIENCE);
  // ponytail: codes are single-use only by their 2-minute expiry; add a used-jti table if
  // replay inside that window ever matters.
  const code = await signJwt(
    {
      sub: process.env.MCP_OAUTH_CLIENT_ID ?? "claude-connector",
      redirect_uri: parsed.redirect_uri,
      code_challenge: parsed.code_challenge,
      iss: config.issuer,
      aud: config.audience,
      iat: now,
      exp: now + OAUTH_CODE_TTL_SECONDS,
      jti: crypto.randomUUID(),
    },
    config
  );

  const location = new URL(parsed.redirect_uri);
  location.searchParams.set("code", code);
  if (parsed.state) location.searchParams.set("state", parsed.state);
  return NextResponse.redirect(location, 302);
}
