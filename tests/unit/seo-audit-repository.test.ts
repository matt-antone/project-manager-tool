import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditResult } from "@/lib/types/seo-audit";

const queryMock = vi.fn();

vi.mock("@/lib/db", () => ({
  query: queryMock
}));

function sampleAuditResult(): AuditResult {
  return {
    tool: "seo-audit",
    auditedAt: "2026-07-20T00:00:00.000Z",
    site: {
      base: "https://example.com",
      host: "example.com",
      robots: { present: true, sitemaps: [] },
      aiBots: {},
      llmsTxt: { present: false, status: null },
      hard404: null,
      sitemaps: [],
      sitemapUrlCount: 0,
      playwright: false,
      rendersUsed: 0
    },
    pagesCrawled: 3,
    pages: [],
    findings: [],
    scores: { seo: 88, aeo: 42 }
  };
}

describe("seo-audit-repository", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
  });

  describe("createSeoAuditRun", () => {
    it("inserts a queued run with the given url, maxPages, and requestedBy", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: "run-1", status: "queued" }] });

      const { createSeoAuditRun } = await import("@/lib/seo-audit-repository");
      const result = await createSeoAuditRun({
        url: "https://example.com/",
        maxPages: 25,
        requestedBy: "user-1"
      });

      expect(queryMock).toHaveBeenCalledTimes(1);
      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("insert into seo_audit_runs");
      expect(sql).toContain("values ($1, $2, $3, 'queued')");
      expect(params).toEqual(["https://example.com/", 25, "user-1"]);
      expect(result).toEqual({ id: "run-1", status: "queued" });
    });
  });

  describe("markSeoAuditRunRunning", () => {
    it("updates status to running for the given id", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: "run-1", status: "running" }] });

      const { markSeoAuditRunRunning } = await import("@/lib/seo-audit-repository");
      const result = await markSeoAuditRunRunning("run-1");

      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("set status = 'running'");
      expect(sql).toContain("and status = 'queued'");
      expect(params).toEqual(["run-1"]);
      expect(result).toEqual({ id: "run-1", status: "running" });
    });

    it("returns null when no row matches the id", async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });

      const { markSeoAuditRunRunning } = await import("@/lib/seo-audit-repository");
      const result = await markSeoAuditRunRunning("missing");

      expect(result).toBeNull();
    });

    it("returns null when the row is not currently queued (already started elsewhere)", async () => {
      // The `and status = 'queued'` guard makes this atomic: a concurrent
      // caller that already flipped the row to 'running' leaves this
      // update matching zero rows.
      queryMock.mockResolvedValueOnce({ rows: [] });

      const { markSeoAuditRunRunning } = await import("@/lib/seo-audit-repository");
      const result = await markSeoAuditRunRunning("run-1");

      expect(result).toBeNull();
    });
  });

  describe("completeSeoAuditRun", () => {
    it("extracts host, scores, and pagesCrawled from the result and stringifies it for storage", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: "run-1", status: "succeeded" }] });
      const auditResult = sampleAuditResult();

      const { completeSeoAuditRun } = await import("@/lib/seo-audit-repository");
      await completeSeoAuditRun("run-1", auditResult);

      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("set status = 'succeeded'");
      expect(params).toEqual([
        "run-1",
        JSON.stringify(auditResult),
        "example.com",
        88,
        42,
        3
      ]);
    });

    it("returns null when no row matches the id", async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });

      const { completeSeoAuditRun } = await import("@/lib/seo-audit-repository");
      const result = await completeSeoAuditRun("missing", sampleAuditResult());

      expect(result).toBeNull();
    });
  });

  describe("failSeoAuditRun", () => {
    it("stores a short error message unchanged", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: "run-1", status: "failed" }] });

      const { failSeoAuditRun } = await import("@/lib/seo-audit-repository");
      await failSeoAuditRun("run-1", "fetch timed out");

      const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(["run-1", "fetch timed out"]);
    });

    it("truncates an error message longer than 2000 characters and appends an ellipsis", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: "run-1", status: "failed" }] });
      const longMessage = "x".repeat(2500);

      const { failSeoAuditRun } = await import("@/lib/seo-audit-repository");
      await failSeoAuditRun("run-1", longMessage);

      const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
      const storedMessage = params[1] as string;
      expect(storedMessage).toHaveLength(2001); // 2000 chars + "…"
      expect(storedMessage.endsWith("…")).toBe(true);
      expect(storedMessage.startsWith("x".repeat(2000))).toBe(true);
    });

    it("does not truncate a message exactly at the 2000-character limit", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: "run-1", status: "failed" }] });
      const exactMessage = "y".repeat(2000);

      const { failSeoAuditRun } = await import("@/lib/seo-audit-repository");
      await failSeoAuditRun("run-1", exactMessage);

      const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(params[1]).toBe(exactMessage);
    });

    it("returns null when no row matches the id", async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });

      const { failSeoAuditRun } = await import("@/lib/seo-audit-repository");
      const result = await failSeoAuditRun("missing", "error");

      expect(result).toBeNull();
    });
  });

  describe("getSeoAuditRunForUser", () => {
    it("selects a run by id scoped to its owner", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: "run-1" }] });

      const { getSeoAuditRunForUser } = await import("@/lib/seo-audit-repository");
      const result = await getSeoAuditRunForUser("run-1", "user-1");

      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("where id = $1");
      expect(sql).toContain("requested_by = $2");
      expect(params).toEqual(["run-1", "user-1"]);
      expect(result).toEqual({ id: "run-1" });
    });

    it("returns null when the run does not exist or belongs to a different user", async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });

      const { getSeoAuditRunForUser } = await import("@/lib/seo-audit-repository");
      const result = await getSeoAuditRunForUser("run-1", "someone-else");

      expect(result).toBeNull();
    });
  });

  describe("listSeoAuditRunsForUser", () => {
    it("filters by requestedBy, orders by created_at desc, and applies the limit", async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: "run-1" }, { id: "run-2" }] });

      const { listSeoAuditRunsForUser } = await import("@/lib/seo-audit-repository");
      const result = await listSeoAuditRunsForUser("user-1", 10);

      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("where requested_by = $1");
      expect(sql).toContain("order by created_at desc");
      expect(sql).toContain("limit $2");
      expect(params).toEqual(["user-1", 10]);
      expect(result).toEqual([{ id: "run-1" }, { id: "run-2" }]);
    });

    it("returns an empty array when the user has no runs", async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });

      const { listSeoAuditRunsForUser } = await import("@/lib/seo-audit-repository");
      const result = await listSeoAuditRunsForUser("user-1", 10);

      expect(result).toEqual([]);
    });
  });

  describe("reapStaleSeoAuditRuns", () => {
    it("marks queued/running rows older than the cutoff as failed and returns the affected count", async () => {
      queryMock.mockResolvedValueOnce({ rows: [], rowCount: 4 });

      const { reapStaleSeoAuditRuns } = await import("@/lib/seo-audit-repository");
      const result = await reapStaleSeoAuditRuns(60);

      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("status in ('queued', 'running')");
      expect(params).toEqual([60]);
      expect(result).toBe(4);
    });

    it("returns 0 when rowCount is undefined", async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });

      const { reapStaleSeoAuditRuns } = await import("@/lib/seo-audit-repository");
      const result = await reapStaleSeoAuditRuns(60);

      expect(result).toBe(0);
    });
  });
});
