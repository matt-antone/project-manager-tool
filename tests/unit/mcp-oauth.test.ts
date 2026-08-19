import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

const BASE = "https://ref.supabase.co/functions/v1/basecamp-mcp";
const AUTHORIZE_URL = "https://pm.example.com/mcp/authorize";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(64);
const JWT_CONFIG = { secret: "unit-test-secret", issuer: "basecamp-mcp", audience: "basecamp-mcp" };

process.env.PM_SERVER_JWT_SECRET = JWT_CONFIG.secret;
process.env.PM_SERVER_JWT_ISSUER = JWT_CONFIG.issuer;
process.env.MCP_OAUTH_PASSWORD = "hunter2";

// oauth.ts runs on Deno; only Deno.env is used.
(globalThis as unknown as { Deno: unknown }).Deno = {
  env: { get: (key: string) => ({ MCP_AUTHORIZE_URL: AUTHORIZE_URL })[key] },
};

let handleOAuth: typeof import("../../supabase/functions/basecamp-mcp/oauth.ts").handleOAuth;
let verifyJwt: typeof import("../../supabase/functions/basecamp-mcp/auth.ts").verifyJwt;
let authorizeGET: typeof import("../../app/mcp/authorize/route").GET;
let authorizePOST: typeof import("../../app/mcp/authorize/route").POST;

beforeAll(async () => {
  ({ handleOAuth } = await import("../../supabase/functions/basecamp-mcp/oauth.ts"));
  ({ verifyJwt } = await import("../../supabase/functions/basecamp-mcp/auth.ts"));
  ({ GET: authorizeGET, POST: authorizePOST } = await import("../../app/mcp/authorize/route"));
});

async function challenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const tokenRequest = (body: URLSearchParams) =>
  handleOAuth(new Request(`${BASE}/token`, { method: "POST", body }), JWT_CONFIG);

async function registerClient(): Promise<string> {
  const res = await handleOAuth(
    new Request(`${BASE}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT] }) }),
    JWT_CONFIG
  );
  return (await res!.json()).client_id;
}

function authorizeParams(clientId: string, codeChallenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: "code",
    code_challenge: codeChallenge, code_challenge_method: "S256", state: "xyz", ...extra,
  });
}

async function authorize(clientId: string, codeChallenge: string, password = "hunter2") {
  const body = authorizeParams(clientId, codeChallenge, { password });
  return await authorizePOST(new NextRequest(AUTHORIZE_URL, { method: "POST", body }));
}

describe("MCP OAuth (Claude connector)", () => {
  it("advertises the public /functions/v1 URL even though the runtime strips it", async () => {
    const req = new Request("https://ref.supabase.co/basecamp-mcp/.well-known/oauth-authorization-server");
    const res = await handleOAuth(req, JWT_CONFIG);
    expect((await res!.json()).issuer).toBe(BASE);
  });

  it("points the authorization endpoint at the app, since Supabase strips HTML", async () => {
    const res = await handleOAuth(new Request(`${BASE}/.well-known/oauth-authorization-server`), JWT_CONFIG);
    expect(await res!.json()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: AUTHORIZE_URL,
      token_endpoint: `${BASE}/token`,
    });
  });

  it("serves a real HTML consent page from the app", async () => {
    const clientId = await registerClient();
    const res = await authorizeGET(
      new NextRequest(`${AUTHORIZE_URL}?${authorizeParams(clientId, await challenge(VERIFIER))}`)
    );
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('name="password"');
  });

  it("completes register → authorize → token with PKCE", async () => {
    const clientId = await registerClient();
    const redirect = new URL((await authorize(clientId, await challenge(VERIFIER))).headers.get("location")!);
    expect(redirect.searchParams.get("state")).toBe("xyz");

    const res = await tokenRequest(new URLSearchParams({
      grant_type: "authorization_code", code: redirect.searchParams.get("code")!,
      redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId,
    }));
    const body = await res!.json();
    expect((await verifyJwt(body.access_token, JWT_CONFIG)).sub).toBe("claude-connector");

    const refreshed = await tokenRequest(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: body.refresh_token })
    );
    expect((await refreshed!.json()).access_token).toBeTruthy();
  });

  it("rejects a bad PKCE verifier", async () => {
    const clientId = await registerClient();
    const redirect = new URL((await authorize(clientId, await challenge(VERIFIER))).headers.get("location")!);
    const res = await tokenRequest(new URLSearchParams({
      grant_type: "authorization_code", code: redirect.searchParams.get("code")!,
      redirect_uri: REDIRECT, code_verifier: "wrong-verifier", client_id: clientId,
    }));
    expect(res!.status).toBe(400);
  });

  it("rejects a wrong password and an unregistered redirect_uri", async () => {
    const clientId = await registerClient();
    const bad = await authorize(clientId, await challenge(VERIFIER), "nope");
    expect(bad.status).toBe(200); // re-renders the login form, no code issued
    expect(await bad.text()).toContain("Incorrect password");

    const evil = await authorizePOST(new NextRequest(AUTHORIZE_URL, {
      method: "POST",
      body: authorizeParams(clientId, await challenge(VERIFIER), { password: "hunter2", redirect_uri: "https://evil.example/cb" }),
    }));
    expect(evil.status).toBe(400);
  });
});
