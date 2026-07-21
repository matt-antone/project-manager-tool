import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const getSeoAuditRunForUserMock = vi.fn();
const reapStaleSeoAuditRunsMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireUser: requireUserMock
}));

vi.mock("@/lib/seo-audit-repository", () => ({
  getSeoAuditRunForUser: getSeoAuditRunForUserMock,
  reapStaleSeoAuditRuns: reapStaleSeoAuditRunsMock,
  STALE_SEO_AUDIT_RUN_MINUTES: 5
}));

const VALID_RUN_ID = "11111111-1111-4111-8111-111111111111";

function authedRequest() {
  return new Request(`http://localhost/api/tools/seo-audit/${VALID_RUN_ID}`, {
    headers: { authorization: "Bearer token" }
  });
}

function paramsFor(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

describe("GET /api/tools/seo-audit/[runId]", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
    getSeoAuditRunForUserMock.mockReset();
    reapStaleSeoAuditRunsMock.mockReset();
    reapStaleSeoAuditRunsMock.mockResolvedValue(0);
  });

  it("returns 401 when requireUser throws", async () => {
    requireUserMock.mockRejectedValue(new Error("Missing bearer token"));

    const { GET } = await import("@/app/api/tools/seo-audit/[runId]/route");
    const response = await GET(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(401);
    expect(getSeoAuditRunForUserMock).not.toHaveBeenCalled();
  });

  it("returns 404 without calling the repository for a non-UUID runId", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { GET } = await import("@/app/api/tools/seo-audit/[runId]/route");
    const response = await GET(authedRequest(), paramsFor("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(getSeoAuditRunForUserMock).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the run belongs to another user, pinning the ownership pairing", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    getSeoAuditRunForUserMock.mockResolvedValue(null);

    const { GET } = await import("@/app/api/tools/seo-audit/[runId]/route");
    const response = await GET(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(404);
    expect(getSeoAuditRunForUserMock).toHaveBeenCalledWith(VALID_RUN_ID, "user-1");
  });

  it("returns the run on success without reaping when it is fresh", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    const run = {
      id: VALID_RUN_ID,
      status: "queued",
      createdAt: new Date().toISOString()
    };
    getSeoAuditRunForUserMock.mockResolvedValue(run);

    const { GET } = await import("@/app/api/tools/seo-audit/[runId]/route");
    const response = await GET(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run });
    expect(reapStaleSeoAuditRunsMock).not.toHaveBeenCalled();
  });

  it("reaps and refetches when a non-terminal run is stale", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    const staleRun = {
      id: VALID_RUN_ID,
      status: "running",
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString()
    };
    const reapedRun = { ...staleRun, status: "failed" };
    getSeoAuditRunForUserMock.mockResolvedValueOnce(staleRun).mockResolvedValueOnce(reapedRun);

    const { GET } = await import("@/app/api/tools/seo-audit/[runId]/route");
    const response = await GET(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(reapStaleSeoAuditRunsMock).toHaveBeenCalledWith(5);
    await expect(response.json()).resolves.toEqual({ run: reapedRun });
  });
});
