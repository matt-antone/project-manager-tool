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

const sampleProdRow = {
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
};

describe("runProjectsPhaseRefresh", () => {
  it("updates mutable fields on a mapped project (matched_existing=false), resolving client_id via map", async () => {
    const ctx = makeCtx();

    (ctx.prod.query as any).mockResolvedValueOnce({ rows: [sampleProdRow] });

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      // per-row map lookup (new impl uses prod_id = $1)
      if (/select local_id from import_map_prod_projects/i.test(sql)) {
        return { rows: [{ local_id: "local-p1" }] };
      }
      if (/from import_map_prod_clients/i.test(sql)) {
        return { rows: [{ local_id: "local-client-1" }] };
      }
      return { rows: [] };
    });

    const result = await runProjectsPhaseRefresh(ctx);

    expect(result.scanned).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.newWatermark.getTime()).toBe(0);
    expect(result.kind).toBe("refresh");

    const updateCall = seen.find((s) => /update projects/i.test(s.sql));
    expect(updateCall).toBeTruthy();
    expect(updateCall!.params[0]).toBe("local-p1");              // local id
    expect(updateCall!.params[1]).toBe("Alpha Project Updated"); // name
    expect(updateCall!.params[4]).toBe("local-client-1");        // resolved client_id
    expect(updateCall!.params[5]).toBe("active");                // status
  });

  it("also updates mapped projects with matched_existing=true (prod status wins)", async () => {
    const ctx = makeCtx();

    (ctx.prod.query as any).mockResolvedValueOnce({ rows: [{ ...sampleProdRow, status: "complete" }] });

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/select local_id from import_map_prod_projects/i.test(sql)) {
        // matched_existing=true row — should still be updated now
        return { rows: [{ local_id: "local-p1" }] };
      }
      if (/from import_map_prod_clients/i.test(sql)) {
        return { rows: [{ local_id: "local-client-1" }] };
      }
      return { rows: [] };
    });

    const result = await runProjectsPhaseRefresh(ctx);

    expect(result.scanned).toBe(1);
    expect(result.inserted).toBe(1); // was 0 before fix
    expect(result.failed).toBe(0);

    const updateCall = seen.find((s) => /update projects/i.test(s.sql));
    expect(updateCall).toBeTruthy();
    expect(updateCall!.params[5]).toBe("complete"); // prod status propagated
  });

  it("unmapped test row + code match → writes map row and updates", async () => {
    const ctx = makeCtx();

    (ctx.prod.query as any).mockResolvedValueOnce({ rows: [sampleProdRow] });

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      // No map row for this prod_id
      if (/select local_id from import_map_prod_projects/i.test(sql)) {
        return { rows: [] };
      }
      // Code-match lookup returns existing test project
      if (/from projects where.*regexp_replace/i.test(sql)) {
        return { rows: [{ id: "existing-test-uuid" }] };
      }
      if (/from import_map_prod_clients/i.test(sql)) {
        return { rows: [{ local_id: "local-client-1" }] };
      }
      return { rows: [] };
    });

    const result = await runProjectsPhaseRefresh(ctx);

    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);

    // Map row written with matched_existing=true
    const mapInsert = seen.find((s) => /insert into import_map_prod_projects/i.test(s.sql));
    expect(mapInsert).toBeTruthy();
    expect(mapInsert!.params[0]).toBe("prod-p1");          // prod_id
    expect(mapInsert!.params[1]).toBe("existing-test-uuid"); // local_id
    expect(mapInsert!.params[2]).toBe(true);               // matched_existing

    // UPDATE fired for the matched local_id
    const updateCall = seen.find((s) => /update projects/i.test(s.sql));
    expect(updateCall).toBeTruthy();
    expect(updateCall!.params[0]).toBe("existing-test-uuid");
  });

  it("unmapped test row + no code match → skip, no update", async () => {
    const ctx = makeCtx();

    (ctx.prod.query as any).mockResolvedValueOnce({ rows: [sampleProdRow] });

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      // No map row
      if (/select local_id from import_map_prod_projects/i.test(sql)) {
        return { rows: [] };
      }
      // No code match
      if (/from projects where.*regexp_replace/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await runProjectsPhaseRefresh(ctx);

    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(0);

    // No UPDATE should have fired
    expect(seen.some((s) => /update projects/i.test(s.sql))).toBe(false);
    // No map insert either
    expect(seen.some((s) => /insert into import_map_prod_projects/i.test(s.sql))).toBe(false);
  });
});
