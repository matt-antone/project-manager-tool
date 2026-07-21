import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const createSeoAuditRunMock = vi.fn();
const listSeoAuditRunsForUserMock = vi.fn();
const reapStaleSeoAuditRunsMock = vi.fn();
const runApiAuditMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireUser: requireUserMock
}));

vi.mock("@/lib/seo-audit-repository", () => ({
  createSeoAuditRun: createSeoAuditRunMock,
  listSeoAuditRunsForUser: listSeoAuditRunsForUserMock,
  reapStaleSeoAuditRuns: reapStaleSeoAuditRunsMock,
  STALE_SEO_AUDIT_RUN_MINUTES: 5
}));

vi.mock("@matt-antone/seo-audit/src/audit-api.js", () => ({
  runApiAudit: runApiAuditMock
}));

function authedRequest(body: unknown) {
  return new Request("http://localhost/api/tools/seo-audit", {
    method: "POST",
    headers: {
      authorization: "Bearer token",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

describe("POST /api/tools/seo-audit", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
    createSeoAuditRunMock.mockReset();
    listSeoAuditRunsForUserMock.mockReset();
    reapStaleSeoAuditRunsMock.mockReset();
    runApiAuditMock.mockReset();
    reapStaleSeoAuditRunsMock.mockResolvedValue(0);
  });

  it("returns 401 when requireUser throws", async () => {
    requireUserMock.mockRejectedValue(new Error("Missing bearer token"));

    const { POST } = await import("@/app/api/tools/seo-audit/route");
    const response = await POST(authedRequest({ url: "https://example.com" }));

    expect(response.status).toBe(401);
    expect(createSeoAuditRunMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing url", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { POST } = await import("@/app/api/tools/seo-audit/route");
    const response = await POST(authedRequest({}));

    expect(response.status).toBe(400);
    expect(createSeoAuditRunMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty url", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { POST } = await import("@/app/api/tools/seo-audit/route");
    const response = await POST(authedRequest({ url: "" }));

    expect(response.status).toBe(400);
    expect(createSeoAuditRunMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an SSRF-blocked localhost url", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { POST } = await import("@/app/api/tools/seo-audit/route");
    const response = await POST(authedRequest({ url: "http://localhost/" }));

    expect(response.status).toBe(400);
    expect(createSeoAuditRunMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an SSRF-blocked cloud metadata address", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { POST } = await import("@/app/api/tools/seo-audit/route");
    const response = await POST(authedRequest({ url: "http://169.254.169.254/" }));

    expect(response.status).toBe(400);
    expect(createSeoAuditRunMock).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range maxPages", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { POST } = await import("@/app/api/tools/seo-audit/route");
    const response = await POST(authedRequest({ url: "https://example.com", maxPages: 31 }));

    expect(response.status).toBe(400);
    expect(createSeoAuditRunMock).not.toHaveBeenCalled();
  });

  it("returns 202 with the new runId on success and does not run the audit", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    createSeoAuditRunMock.mockResolvedValue({ id: "run-1", url: "https://example.com/", status: "queued" });

    const { POST } = await import("@/app/api/tools/seo-audit/route");
    const response = await POST(authedRequest({ url: "https://example.com", maxPages: 10 }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ runId: "run-1" });
    expect(createSeoAuditRunMock).toHaveBeenCalledWith({
      url: "https://example.com/",
      maxPages: 10,
      requestedBy: "user-1"
    });
    expect(runApiAuditMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/tools/seo-audit", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
    listSeoAuditRunsForUserMock.mockReset();
  });

  it("returns 401 when requireUser throws", async () => {
    requireUserMock.mockRejectedValue(new Error("Missing bearer token"));

    const { GET } = await import("@/app/api/tools/seo-audit/route");
    const response = await GET(
      new Request("http://localhost/api/tools/seo-audit", {
        headers: { authorization: "Bearer token" }
      })
    );

    expect(response.status).toBe(401);
    expect(listSeoAuditRunsForUserMock).not.toHaveBeenCalled();
  });

  it("returns the caller's runs on success", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    listSeoAuditRunsForUserMock.mockResolvedValue([{ id: "run-1" }]);

    const { GET } = await import("@/app/api/tools/seo-audit/route");
    const response = await GET(
      new Request("http://localhost/api/tools/seo-audit", {
        headers: { authorization: "Bearer token" }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runs: [{ id: "run-1" }] });
    expect(listSeoAuditRunsForUserMock).toHaveBeenCalledWith("user-1", 20);
  });
});
