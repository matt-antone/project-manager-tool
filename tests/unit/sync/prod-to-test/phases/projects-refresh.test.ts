// tests/unit/sync/prod-to-test/phases/projects-refresh.test.ts
import { describe, it, expect, vi } from "vitest";
import { runProjectsPhaseRefresh } from "@/lib/sync/prod-to-test/phases/projects";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(): PhaseCtx {
  const watermarks = new Map();
  return {
    prod: { query: vi.fn() } as any,
    test: { query: vi.fn() } as any,
    prodStorage: {} as any,
    testStorage: {} as any,
    watermarks,
    flags: { phase: null, limitPerPhase: null, noBackup: false, iKnowWhatImDoing: false, refreshMetadata: true },
    log: () => {},
  };
}

describe("runProjectsPhaseRefresh", () => {
  it("updates mutable fields on a mapped project, resolving client_id via map", async () => {
    const ctx = makeCtx();

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/from import_map_prod_projects/i.test(sql)) {
        // Includes matched_existing = false — this row should be refreshed.
        return { rows: [{ prod_id: "prod-p1", local_id: "local-p1", matched_existing: false }] };
      }
      if (/from import_map_prod_clients/i.test(sql)) {
        return { rows: [{ local_id: "local-client-1" }] };
      }
      return { rows: [] };
    });

    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: "prod-p1",
          name: "Alpha Project Updated",
          description: "New description",
          archived: false,
          client_id: "prod-c1",
          status: "active",
          project_seq: 10,
          tags: ["urgent"],
          requestor: "alice",
          deadline: "2026-12-31",
          last_activity_at: new Date("2026-05-11T00:00:00Z"),
          pm_note: "Check in weekly",
          project_code: "ALPHA-01",
          client_slug: "acme",
          project_slug: "alpha-project",
          storage_project_dir: "acme/alpha-project",
        },
      ],
    });

    const result = await runProjectsPhaseRefresh(ctx);

    expect(result.scanned).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.newWatermark.getTime()).toBe(0);
    expect(result.kind).toBe("refresh");

    const updateCall = seen.find((s) => /update projects/i.test(s.sql));
    expect(updateCall).toBeTruthy();
    expect(updateCall!.params[0]).toBe("local-p1");     // local id
    expect(updateCall!.params[1]).toBe("Alpha Project Updated"); // name
    expect(updateCall!.params[4]).toBe("local-client-1"); // resolved client_id
    expect(updateCall!.params[5]).toBe("active");         // status
  });

  it("does not update projects whose map row has matched_existing = true", async () => {
    const ctx = makeCtx();

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/from import_map_prod_projects/i.test(sql)) {
        // matched_existing = true rows filtered out by the WHERE clause — return empty.
        return { rows: [] };
      }
      return { rows: [] };
    });

    (ctx.prod.query as any).mockResolvedValueOnce({ rows: [] });

    const result = await runProjectsPhaseRefresh(ctx);
    expect(result.scanned).toBe(0);
    expect(result.inserted).toBe(0);
    // No UPDATE should have fired.
    expect(seen.some((s) => /update projects/i.test(s.sql))).toBe(false);
  });
});
