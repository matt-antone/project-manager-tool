// tests/unit/sync/prod-to-test/phases/project-sub-tables.test.ts
//
// Tests for syncProjectSubTables behaviour, exercised through the public
// phase entry-points (runProjectsPhase / runProjectsPhaseRefresh).
//
import { describe, it, expect, vi } from "vitest";
import { runProjectsPhase, runProjectsPhaseRefresh } from "@/lib/sync/prod-to-test/phases/projects";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInsertCtx(): PhaseCtx {
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
    flags: { phase: null, limitPerPhase: null, noBackup: false, iKnowWhatImDoing: false, refreshMetadata: false },
    log: () => {},
  };
}

function makeRefreshCtx(): PhaseCtx {
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

// Minimal prod project row for insert-phase tests.
const sampleProdProject = {
  id: "prod-p1",
  name: "Test Project",
  slug: "test-project",
  description: null,
  archived: false,
  created_by: "prod-user-1",
  client_id: null,
  project_code: null,
  client_slug: null,
  project_slug: "test-project",
  storage_project_dir: null,
  status: "in_progress",
  project_seq: 1,
  tags: [],
  requestor: null,
  deadline: null,
  last_activity_at: null,
  pm_note: null,
  created_at: new Date("2026-04-01T00:00:00Z"),
};

// Minimal prod project row for refresh-phase tests.
const sampleRefreshRow = {
  id: "prod-p1",
  name: "Test Project",
  description: null,
  archived: false,
  client_id: null,
  status: "in_progress",
  project_seq: 1,
  tags: [],
  requestor: null,
  deadline: null,
  last_activity_at: null,
  pm_note: null,
  project_code: null,
  client_slug: null,
  project_slug: "test-project",
  storage_project_dir: null,
};

// ---------------------------------------------------------------------------
// 1. Members are replaced from prod
// ---------------------------------------------------------------------------
describe("project_members sync via runProjectsPhase", () => {
  it("deletes test members then inserts prod members with resolved user_ids", async () => {
    const ctx = makeInsertCtx();

    // prod returns 1 project row, then 2 members, then empty for expenses/hours
    let prodCallIdx = 0;
    (ctx.prod.query as any).mockImplementation((sql: string) => {
      // First call: projects query
      if (/from projects/i.test(sql) && !/members|expense|hours/i.test(sql)) {
        return { rows: [sampleProdProject] };
      }
      if (/from project_members/i.test(sql)) {
        return {
          rows: [
            { user_id: "prod-user-A", added_at: new Date("2026-01-01T00:00:00Z") },
            { user_id: "prod-user-B", added_at: new Date("2026-02-01T00:00:00Z") },
          ],
        };
      }
      if (/from project_expense_lines/i.test(sql)) return { rows: [] };
      if (/from project_user_hours/i.test(sql)) return { rows: [] };
      return { rows: [] };
    });

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      // map lookups — not yet mapped
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
      if (/from projects where.*project_code/i.test(sql)) return { rows: [] };
      // user-ref resolution via import_map_prod_users
      if (/from import_map_prod_users/i.test(sql)) {
        const prodId = params[0];
        if (prodId === "prod-user-1") return { rows: [{ local_id: "local-user-created-by" }] };
        if (prodId === "prod-user-A") return { rows: [{ local_id: "local-user-A" }] };
        if (prodId === "prod-user-B") return { rows: [{ local_id: "local-user-B" }] };
        return { rows: [] };
      }
      return { rows: [] };
    });

    await runProjectsPhase(ctx);

    // delete from project_members fired for the local project
    const deleteMembersCall = seen.find(
      (s) => /delete from project_members/i.test(s.sql)
    );
    expect(deleteMembersCall).toBeTruthy();

    // two inserts into project_members with resolved local user ids
    const memberInserts = seen.filter((s) => /insert into project_members/i.test(s.sql));
    expect(memberInserts).toHaveLength(2);
    const insertedUserIds = memberInserts.map((s) => s.params[1]);
    expect(insertedUserIds).toContain("local-user-A");
    expect(insertedUserIds).toContain("local-user-B");
  });
});

// ---------------------------------------------------------------------------
// 2. Expense lines are replaced
// ---------------------------------------------------------------------------
describe("project_expense_lines sync via runProjectsPhase", () => {
  it("deletes test expense lines then inserts prod expense lines", async () => {
    const ctx = makeInsertCtx();

    (ctx.prod.query as any).mockImplementation((sql: string) => {
      if (/from projects/i.test(sql) && !/members|expense|hours/i.test(sql)) {
        return { rows: [sampleProdProject] };
      }
      if (/from project_members/i.test(sql)) return { rows: [] };
      if (/from project_expense_lines/i.test(sql)) {
        return {
          rows: [
            { label: "Design work", amount: "1500.00", sort_order: 0, created_at: new Date("2026-03-01T00:00:00Z") },
            { label: "Dev work", amount: "4000.00", sort_order: 1, created_at: new Date("2026-03-02T00:00:00Z") },
          ],
        };
      }
      if (/from project_user_hours/i.test(sql)) return { rows: [] };
      return { rows: [] };
    });

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
      if (/from projects where.*project_code/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "local-user-created-by" }] };
      return { rows: [] };
    });

    await runProjectsPhase(ctx);

    const deleteExpenses = seen.find((s) => /delete from project_expense_lines/i.test(s.sql));
    expect(deleteExpenses).toBeTruthy();

    const expenseInserts = seen.filter((s) => /insert into project_expense_lines/i.test(s.sql));
    expect(expenseInserts).toHaveLength(2);

    const labels = expenseInserts.map((s) => s.params[1]);
    expect(labels).toContain("Design work");
    expect(labels).toContain("Dev work");

    // amounts passed through as strings (pg numeric → string)
    const amounts = expenseInserts.map((s) => s.params[2]);
    expect(amounts).toContain("1500.00");
    expect(amounts).toContain("4000.00");
  });
});

// ---------------------------------------------------------------------------
// 3. user_hours resolves user_id via resolveUserRef (via refresh phase)
// ---------------------------------------------------------------------------
describe("project_user_hours sync via runProjectsPhaseRefresh", () => {
  it("inserts hours using resolved local user_id", async () => {
    const ctx = makeRefreshCtx();

    (ctx.prod.query as any).mockImplementation((sql: string) => {
      if (/from projects/i.test(sql) && !/members|expense|hours/i.test(sql)) {
        return { rows: [sampleRefreshRow] };
      }
      if (/from project_members/i.test(sql)) return { rows: [] };
      if (/from project_expense_lines/i.test(sql)) return { rows: [] };
      if (/from project_user_hours/i.test(sql)) {
        return {
          rows: [
            { user_id: "prod-user-X", hours: "12.5", created_at: new Date("2026-04-10T00:00:00Z") },
          ],
        };
      }
      return { rows: [] };
    });

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/select local_id from import_map_prod_projects/i.test(sql)) {
        return { rows: [{ local_id: "local-p1" }] };
      }
      if (/from import_map_prod_clients/i.test(sql)) return { rows: [] };
      // user-ref for prod-user-X → local-user-X
      if (/from import_map_prod_users/i.test(sql)) {
        if (params[0] === "prod-user-X") return { rows: [{ local_id: "local-user-X" }] };
        return { rows: [] };
      }
      return { rows: [] };
    });

    await runProjectsPhaseRefresh(ctx);

    const deleteHours = seen.find((s) => /delete from project_user_hours/i.test(s.sql));
    expect(deleteHours).toBeTruthy();

    const hoursInsert = seen.find((s) => /insert into project_user_hours/i.test(s.sql));
    expect(hoursInsert).toBeTruthy();
    // project_id = local-p1, user_id = resolved local-user-X, hours = "12.5"
    expect(hoursInsert!.params[0]).toBe("local-p1");
    expect(hoursInsert!.params[1]).toBe("local-user-X");
    expect(hoursInsert!.params[2]).toBe("12.5");
  });
});
