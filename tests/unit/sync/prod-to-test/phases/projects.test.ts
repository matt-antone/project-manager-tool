// tests/unit/sync/prod-to-test/phases/projects.test.ts
import { describe, it, expect, vi } from "vitest";
import { runProjectsPhase } from "@/lib/sync/prod-to-test/phases/projects";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(): PhaseCtx {
  const watermarks = new Map();
  watermarks.set("projects", new Date(0));
  watermarks.set("clients", new Date(0));
  watermarks.set("users", new Date(0));
  return {
    prod: { query: vi.fn() } as any,
    test: { query: vi.fn() } as any,
    prodStorage: {} as any,
    testStorage: {} as any,
    watermarks,
    flags: { phase: null, limitPerPhase: null, noBackup: false, iKnowWhatImDoing: false },
    log: () => {},
  };
}

const sampleProdProject = {
  id: "p1",
  name: "New Project",
  slug: "new-project",
  description: null,
  archived: false,
  created_by: "prod-user-1",
  client_id: "c1",
  project_code: "ACME-0042",
  client_slug: "acme",
  project_slug: "new-project",
  storage_project_dir: "acme/new-project",
  status: "in_progress",
  project_seq: 42,
  tags: ["tag-a"],
  requestor: null,
  deadline: null,
  last_activity_at: new Date("2026-04-15T00:00:00Z"),
  pm_note: null,
  created_at: new Date("2026-04-15T00:00:00Z"),
};

describe("runProjectsPhase", () => {
  it("inserts a new project, resolving client_id and created_by via maps", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdProject] });

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
      // Match-by-code lookup returns empty → falls through to INSERT.
      if (/from projects where.*project_code/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_clients/i.test(sql)) {
        return { rows: [{ local_id: "local-client-1" }] };
      }
      if (/from import_map_prod_users/i.test(sql)) {
        return { rows: [{ local_id: "local-user-1" }] };
      }
      return { rows: [] };
    });

    const result = await runProjectsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    const insertProj = seen.find((s) => /insert into projects/i.test(s.sql));
    expect(insertProj).toBeTruthy();
    expect(insertProj!.params).toContain("local-client-1");
    expect(insertProj!.params).toContain("local-user-1");
    // map row should have matched_existing = false
    const mapInsert = seen.find((s) => /insert into import_map_prod_projects/i.test(s.sql));
    expect(mapInsert).toBeTruthy();
    expect(mapInsert!.params[2]).toBe(false);
  });

  it("retries with -p<prefix> suffix on slug/project_code unique violation", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdProject] });

    let projectInsertCalls = 0;
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
      // Match-by-code lookup returns empty → falls through to INSERT.
      if (/from projects where.*project_code/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_clients/i.test(sql)) return { rows: [{ local_id: "lc" }] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      if (/insert into projects/i.test(sql)) {
        projectInsertCalls++;
        if (projectInsertCalls === 1) {
          const err: any = new Error("duplicate key");
          err.code = "23505";
          throw err;
        }
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await runProjectsPhase(ctx);
    expect(projectInsertCalls).toBe(2);
    expect(result.inserted).toBe(1);
  });

  it("matches by project_code, writes map row with matched_existing=true, no projects insert", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdProject] });

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
      // Match-by-code lookup returns existing test project.
      if (/from projects where.*project_code/i.test(sql)) {
        return { rows: [{ id: "existing-test-uuid" }] };
      }
      return { rows: [] };
    });

    const result = await runProjectsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    // No INSERT into projects should have fired.
    expect(seen.some((s) => /insert into projects\b/i.test(s.sql))).toBe(false);
    // Map row should carry matched_existing = true and local_id = "existing-test-uuid".
    const mapInsert = seen.find((s) => /insert into import_map_prod_projects/i.test(s.sql));
    expect(mapInsert).toBeTruthy();
    expect(mapInsert!.params[1]).toBe("existing-test-uuid");
    expect(mapInsert!.params[2]).toBe(true);
  });

  it("matched_existing reflects whether INSERT actually ran (two scenarios)", async () => {
    // Scenario A: code match → no INSERT → matched_existing=true
    {
      const ctx = makeCtx();
      (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdProject] });
      const seen: Array<{ sql: string; params: any[] }> = [];
      (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
        seen.push({ sql, params });
        if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
        if (/from projects where.*project_code/i.test(sql)) {
          return { rows: [{ id: "existing-uuid" }] };
        }
        return { rows: [] };
      });
      await runProjectsPhase(ctx);
      const mapInsert = seen.find((s) => /insert into import_map_prod_projects/i.test(s.sql));
      expect(mapInsert!.params[2]).toBe(true); // matched_existing = true when INSERT did NOT run
      expect(seen.some((s) => /insert into projects\b/i.test(s.sql))).toBe(false);
    }

    // Scenario B: no code match → INSERT runs → matched_existing=false
    {
      const ctx = makeCtx();
      (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdProject] });
      const seen: Array<{ sql: string; params: any[] }> = [];
      (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
        seen.push({ sql, params });
        if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
        if (/from projects where.*project_code/i.test(sql)) return { rows: [] };
        if (/from import_map_prod_clients/i.test(sql)) return { rows: [{ local_id: "lc" }] };
        if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
        return { rows: [] };
      });
      await runProjectsPhase(ctx);
      const mapInsert = seen.find((s) => /insert into import_map_prod_projects/i.test(s.sql));
      expect(mapInsert!.params[2]).toBe(false); // matched_existing = false when INSERT ran
      expect(seen.some((s) => /insert into projects\b/i.test(s.sql))).toBe(true);
    }
  });

  it("matches by project_code across zero-padding drift (prod ALG-005 matches test ALG-0005)", async () => {
    const ctx = makeCtx();
    const prodRow = { ...sampleProdProject, project_code: "ALG-005" };
    (ctx.prod.query as any).mockResolvedValue({ rows: [prodRow] });

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
      // Simulate test DB having ALG-0005 — regexp_replace on both sides unifies them.
      if (/from projects where.*project_code/i.test(sql)) {
        return { rows: [{ id: "existing-alg-0005-uuid" }] };
      }
      return { rows: [] };
    });

    const result = await runProjectsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    // No INSERT into projects — matched existing.
    expect(seen.some((s) => /insert into projects\b/i.test(s.sql))).toBe(false);
    // Map row: local_id = existing-alg-0005-uuid, matched_existing = true.
    const mapInsert = seen.find((s) => /insert into import_map_prod_projects/i.test(s.sql));
    expect(mapInsert).toBeTruthy();
    expect(mapInsert!.params[1]).toBe("existing-alg-0005-uuid");
    expect(mapInsert!.params[2]).toBe(true);
  });
});
