import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const getSeoAuditRunForUserMock = vi.fn();
const markSeoAuditRunRunningMock = vi.fn();
const completeSeoAuditRunMock = vi.fn();
const failSeoAuditRunMock = vi.fn();
const runApiAuditMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireUser: requireUserMock
}));

vi.mock("@/lib/seo-audit-repository", () => ({
  getSeoAuditRunForUser: getSeoAuditRunForUserMock,
  markSeoAuditRunRunning: markSeoAuditRunRunningMock,
  completeSeoAuditRun: completeSeoAuditRunMock,
  failSeoAuditRun: failSeoAuditRunMock
}));

vi.mock("@matt-antone/seo-audit/src/audit-api.js", () => ({
  runApiAudit: runApiAuditMock
}));

const VALID_RUN_ID = "22222222-2222-4222-8222-222222222222";

function authedRequest() {
  return new Request(`http://localhost/api/tools/seo-audit/${VALID_RUN_ID}/run`, {
    method: "POST",
    headers: { authorization: "Bearer token" }
  });
}

function paramsFor(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

describe("POST /api/tools/seo-audit/[runId]/run", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
    getSeoAuditRunForUserMock.mockReset();
    markSeoAuditRunRunningMock.mockReset();
    completeSeoAuditRunMock.mockReset();
    failSeoAuditRunMock.mockReset();
    runApiAuditMock.mockReset();
  });

  it("returns 401 when requireUser throws", async () => {
    requireUserMock.mockRejectedValue(new Error("Missing bearer token"));

    const { POST } = await import("@/app/api/tools/seo-audit/[runId]/run/route");
    const response = await POST(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(401);
    expect(getSeoAuditRunForUserMock).not.toHaveBeenCalled();
  });

  it("returns 404 without calling the repository for a non-UUID runId", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { POST } = await import("@/app/api/tools/seo-audit/[runId]/run/route");
    const response = await POST(authedRequest(), paramsFor("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(getSeoAuditRunForUserMock).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the run belongs to another user, pinning the ownership pairing", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    getSeoAuditRunForUserMock.mockResolvedValue(null);

    const { POST } = await import("@/app/api/tools/seo-audit/[runId]/run/route");
    const response = await POST(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(404);
    expect(getSeoAuditRunForUserMock).toHaveBeenCalledWith(VALID_RUN_ID, "user-1");
    expect(markSeoAuditRunRunningMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the run is not queued", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    getSeoAuditRunForUserMock.mockResolvedValue({
      id: VALID_RUN_ID,
      status: "running",
      url: "https://example.com/",
      maxPages: 10
    });

    const { POST } = await import("@/app/api/tools/seo-audit/[runId]/run/route");
    const response = await POST(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(409);
    expect(markSeoAuditRunRunningMock).not.toHaveBeenCalled();
    expect(runApiAuditMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the atomic claim loses the race (markSeoAuditRunRunning returns null)", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    getSeoAuditRunForUserMock.mockResolvedValue({
      id: VALID_RUN_ID,
      status: "queued",
      url: "https://example.com/",
      maxPages: 10
    });
    markSeoAuditRunRunningMock.mockResolvedValue(null);

    const { POST } = await import("@/app/api/tools/seo-audit/[runId]/run/route");
    const response = await POST(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(409);
    expect(runApiAuditMock).not.toHaveBeenCalled();
  });

  it("returns 200 with the completed run on success", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    getSeoAuditRunForUserMock.mockResolvedValue({
      id: VALID_RUN_ID,
      status: "queued",
      url: "https://example.com/",
      maxPages: 10
    });
    markSeoAuditRunRunningMock.mockResolvedValue({
      id: VALID_RUN_ID,
      status: "running",
      url: "https://example.com/",
      maxPages: 10
    });
    const auditResult = { site: { host: "example.com" }, scores: { seo: 90, aeo: 80 }, pagesCrawled: 1 };
    runApiAuditMock.mockResolvedValue(auditResult);
    const completedRun = { id: VALID_RUN_ID, status: "succeeded", result: auditResult };
    completeSeoAuditRunMock.mockResolvedValue(completedRun);

    const { POST } = await import("@/app/api/tools/seo-audit/[runId]/run/route");
    const response = await POST(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: completedRun });
    expect(runApiAuditMock).toHaveBeenCalledWith({ url: "https://example.com/", maxPages: 10 });
    expect(failSeoAuditRunMock).not.toHaveBeenCalled();
  });

  it("marks the run failed and returns 200 (not 500) when runApiAudit throws", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    getSeoAuditRunForUserMock.mockResolvedValue({
      id: VALID_RUN_ID,
      status: "queued",
      url: "https://example.com/",
      maxPages: 10
    });
    markSeoAuditRunRunningMock.mockResolvedValue({
      id: VALID_RUN_ID,
      status: "running",
      url: "https://example.com/",
      maxPages: 10
    });
    runApiAuditMock.mockRejectedValue(new Error("upstream crawl failed"));
    const failedRun = { id: VALID_RUN_ID, status: "failed", error: "upstream crawl failed" };
    failSeoAuditRunMock.mockResolvedValue(failedRun);

    const { POST } = await import("@/app/api/tools/seo-audit/[runId]/run/route");
    const response = await POST(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: failedRun });
    expect(failSeoAuditRunMock).toHaveBeenCalledWith(VALID_RUN_ID, "upstream crawl failed");
    expect(completeSeoAuditRunMock).not.toHaveBeenCalled();
  });
});
