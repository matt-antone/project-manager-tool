import { describe, it, expect, vi } from "vitest";
import { runThreadsPhase } from "@/lib/sync/prod-to-test/phases/threads";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(): PhaseCtx {
  const watermarks = new Map();
  watermarks.set("threads", new Date(0));
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

const sampleProdThread = {
  id: "t1",
  project_id: "p1",
  title: "Hi",
  body_markdown: "# hi",
  body_html: "<h1>hi</h1>",
  author_user_id: "prod-user-1",
  edited_at: null,
  created_at: new Date("2026-04-20T00:00:00Z"),
};

describe("runThreadsPhase", () => {
  it("inserts thread when project + user maps resolve", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdThread] });
    const seen: string[] = [];
    (ctx.test as any).query = vi.fn((sql: string) => {
      seen.push(sql);
      if (/from import_map_prod_threads/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [{ local_id: "lp" }] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      return { rows: [] };
    });
    const result = await runThreadsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(seen.some((s) => /insert into discussion_threads/i.test(s))).toBe(true);
  });

  it("fails the row when project map is missing", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdThread] });
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_threads/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      return { rows: [] };
    });
    const result = await runThreadsPhase(ctx);
    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].reason).toMatch(/unresolved project/);
  });
});
