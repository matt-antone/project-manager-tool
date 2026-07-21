import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const getSeoAuditRunForUserMock = vi.fn();
const renderToBufferMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireUser: requireUserMock
}));

vi.mock("@/lib/seo-audit-repository", () => ({
  getSeoAuditRunForUser: getSeoAuditRunForUserMock
}));

vi.mock("@react-pdf/renderer", () => ({
  Document: "Document",
  Page: "Page",
  Text: "Text",
  View: "View",
  StyleSheet: { create: (styles: unknown) => styles },
  renderToBuffer: renderToBufferMock
}));

const VALID_RUN_ID = "33333333-3333-4333-8333-333333333333";

function authedRequest() {
  return new Request(`http://localhost/api/tools/seo-audit/${VALID_RUN_ID}/pdf`, {
    headers: { authorization: "Bearer token" }
  });
}

function paramsFor(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

const auditResult = {
  tool: "seo-audit",
  auditedAt: new Date().toISOString(),
  site: {
    base: "https://example.com/",
    host: "example.com",
    robots: { present: true, sitemaps: [] },
    aiBots: {},
    llmsTxt: { present: false, status: null },
    hard404: null,
    sitemaps: [],
    sitemapUrlCount: 0,
    playwright: true,
    rendersUsed: 0
  },
  pagesCrawled: 1,
  pages: [],
  findings: [],
  scores: { seo: 90, aeo: 80 }
};

describe("GET /api/tools/seo-audit/[runId]/pdf", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
    getSeoAuditRunForUserMock.mockReset();
    renderToBufferMock.mockReset();
    renderToBufferMock.mockResolvedValue(Buffer.from("pdf-bytes"));
  });

  it("returns 401 when requireUser throws", async () => {
    requireUserMock.mockRejectedValue(new Error("Missing bearer token"));

    const { GET } = await import("@/app/api/tools/seo-audit/[runId]/pdf/route");
    const response = await GET(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(401);
    expect(getSeoAuditRunForUserMock).not.toHaveBeenCalled();
  });

  it("returns 404 without calling the repository for a non-UUID runId", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { GET } = await import("@/app/api/tools/seo-audit/[runId]/pdf/route");
    const response = await GET(authedRequest(), paramsFor("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(getSeoAuditRunForUserMock).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the run belongs to another user, pinning the ownership pairing", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    getSeoAuditRunForUserMock.mockResolvedValue(null);

    const { GET } = await import("@/app/api/tools/seo-audit/[runId]/pdf/route");
    const response = await GET(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(404);
    expect(getSeoAuditRunForUserMock).toHaveBeenCalledWith(VALID_RUN_ID, "user-1");
  });

  it("returns 409 when the run has not succeeded", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    getSeoAuditRunForUserMock.mockResolvedValue({
      id: VALID_RUN_ID,
      status: "running",
      result: null,
      host: null
    });

    const { GET } = await import("@/app/api/tools/seo-audit/[runId]/pdf/route");
    const response = await GET(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(409);
    expect(renderToBufferMock).not.toHaveBeenCalled();
  });

  it("returns 409 when status is succeeded but result is missing", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    getSeoAuditRunForUserMock.mockResolvedValue({
      id: VALID_RUN_ID,
      status: "succeeded",
      result: null,
      host: "example.com"
    });

    const { GET } = await import("@/app/api/tools/seo-audit/[runId]/pdf/route");
    const response = await GET(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(409);
    expect(renderToBufferMock).not.toHaveBeenCalled();
  });

  it("returns 200 with a PDF attachment on success", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    getSeoAuditRunForUserMock.mockResolvedValue({
      id: VALID_RUN_ID,
      status: "succeeded",
      result: auditResult,
      host: "example.com"
    });

    const { GET } = await import("@/app/api/tools/seo-audit/[runId]/pdf/route");
    const response = await GET(authedRequest(), paramsFor(VALID_RUN_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    const disposition = response.headers.get("Content-Disposition");
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("seo-audit-example.com-");
    expect(renderToBufferMock).toHaveBeenCalledTimes(1);
  });
});
