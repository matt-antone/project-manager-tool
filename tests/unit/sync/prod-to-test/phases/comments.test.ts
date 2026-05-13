import { describe, it, expect, vi } from "vitest";
import { runCommentsPhase } from "@/lib/sync/prod-to-test/phases/comments";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(): PhaseCtx {
  const watermarks = new Map();
  watermarks.set("comments", new Date(0));
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

const sampleProdComment = {
  id: "c1",
  project_id: "p1",
  thread_id: "t1",
  body_markdown: "lgtm",
  body_html: "<p>lgtm</p>",
  author_user_id: "prod-user-1",
  edited_at: null,
  created_at: new Date("2026-04-25T00:00:00Z"),
};

describe("runCommentsPhase", () => {
  it("inserts a comment, deriving project_id from local thread", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdComment] });
    const inserts: Array<[string, any[]]> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      // matched-existing lookup: no matched projects.
      if (/from import_map_prod_projects where matched_existing/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_comments/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_threads/i.test(sql)) return { rows: [{ local_id: "lt" }] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      if (/select project_id from discussion_threads/i.test(sql)) {
        return { rows: [{ project_id: "lp" }] };
      }
      if (/insert into discussion_comments/i.test(sql)) inserts.push([sql, params]);
      return { rows: [] };
    });
    const result = await runCommentsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(inserts[0][1]).toContain("lp");
  });

  it("passes matched prod_project_ids as $2 exclusion array to prod query", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [] });

    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_projects where matched_existing/i.test(sql)) {
        return { rows: [{ prod_id: "matched-prod-p1" }] };
      }
      return { rows: [] };
    });

    await runCommentsPhase(ctx);

    const prodCall = (ctx.prod.query as any).mock.calls[0];
    expect(prodCall[1][1]).toEqual(["matched-prod-p1"]);
  });

  it("prod SELECT SQL contains active-job filter clauses", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [] });
    (ctx.test as any).query = vi.fn(() => ({ rows: [] }));

    await runCommentsPhase(ctx);

    const prodSql: string = (ctx.prod.query as any).mock.calls[0][0];
    expect(prodSql).toMatch(/archived = false/);
    // status <> 'complete' removed — complete is workflow state, not archived
  });
});
