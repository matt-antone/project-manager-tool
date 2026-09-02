import { describe, it, expect } from "vitest";

const REQUIRED_SMOKE_ENV = ["MCP_SMOKE_URL", "MCP_SMOKE_JWT"] as const;

function readSmokeConfig(env: NodeJS.ProcessEnv) {
  const missing = REQUIRED_SMOKE_ENV.filter((key) => !env[key]);
  return {
    url: env.MCP_SMOKE_URL,
    jwt: env.MCP_SMOKE_JWT,
    missing,
    isConfigured: missing.length === 0,
  };
}

const smoke = readSmokeConfig(process.env);

function expectMissingConfig() {
  expect(smoke.missing.length).toBeGreaterThan(0);
}

async function mcpCall(method: string, params: Record<string, unknown>) {
  if (!smoke.url || !smoke.jwt) {
    throw new Error("MCP smoke config is not available");
  }

  const res = await fetch(smoke.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${smoke.jwt}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  return res.json();
}

describe("MCP smoke test configuration", () => {
  it("declares required environment variables for live smoke checks", () => {
    expect(REQUIRED_SMOKE_ENV).toEqual(["MCP_SMOKE_URL", "MCP_SMOKE_JWT"]);
  });

  it("reports whether live smoke checks are configured", () => {
    if (smoke.isConfigured) {
      expect(smoke.missing).toHaveLength(0);
      return;
    }

    expect(smoke.missing.length).toBeGreaterThan(0);
  });
});

describe("MCP smoke tests (live)", () => {
  it("GET /healthz returns 200 when live smoke config is present", async () => {
    if (!smoke.isConfigured || !smoke.url) {
      expectMissingConfig();
      return;
    }

    const res = await fetch(`${smoke.url}/healthz`);
    expect(res.status).toBe(200);
  });

  it("GET /readyz returns 200 when live smoke config is present", async () => {
    if (!smoke.isConfigured || !smoke.url) {
      expectMissingConfig();
      return;
    }

    const res = await fetch(`${smoke.url}/readyz`);
    expect(res.status).toBe(200);
  });

  it("rejects bad credentials with 401 when live smoke config is present", async () => {
    if (!smoke.isConfigured || !smoke.url) {
      expectMissingConfig();
      return;
    }

    const res = await fetch(smoke.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer not-a-valid-jwt",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("tools/list returns core tools when live smoke config is present", async () => {
    if (!smoke.isConfigured) {
      expectMissingConfig();
      return;
    }

    const response = await mcpCall("tools/list", {});
    expect(response.result?.tools).toHaveLength(22);
    const names = response.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("get_my_profile");
    expect(names).toContain("list_clients");
    expect(names).toContain("get_client");
    expect(names).toContain("download_file");
    expect(names).toContain("create_file");
    expect(names).toContain("upload_file");
    expect(names).toContain("create_upload_link");
  });

  it("list_projects returns an array when live smoke config is present", async () => {
    if (!smoke.isConfigured) {
      expectMissingConfig();
      return;
    }

    const response = await mcpCall("tools/call", {
      name: "list_projects",
      arguments: {},
    });
    const data = JSON.parse(response.result?.content?.[0]?.text ?? "null");
    expect(Array.isArray(data)).toBe(true);
  });

  it("list_clients returns an array when live smoke config is present", async () => {
    if (!smoke.isConfigured) {
      expectMissingConfig();
      return;
    }

    const response = await mcpCall("tools/call", { name: "list_clients", arguments: {} });
    expect(response.result).toBeDefined();
    expect(response.error).toBeUndefined();
    const data = JSON.parse(response.result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
  });
});
