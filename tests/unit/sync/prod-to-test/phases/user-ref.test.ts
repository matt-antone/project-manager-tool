import { describe, it, expect, vi } from "vitest";
import { resolveUserRef } from "@/lib/sync/prod-to-test/phases/user-ref";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(): PhaseCtx {
  const watermarks = new Map();
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

describe("resolveUserRef", () => {
  it("returns mapped local_id when import_map_prod_users hit", async () => {
    const ctx = makeCtx();
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_users/i.test(sql)) {
        return { rows: [{ local_id: "local-u1" }] };
      }
      return { rows: [] };
    });
    const result = await resolveUserRef(ctx, "prod-u1");
    expect(result).toBe("local-u1");
    // prod should never be queried when map already resolves
    expect((ctx.prod.query as any)).not.toHaveBeenCalled();
  });

  it("passes ref through verbatim when prod has no user_profiles row", async () => {
    const ctx = makeCtx();
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_users/i.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    (ctx.prod.query as any) = vi.fn(() => ({ rows: [] }));
    const result = await resolveUserRef(ctx, "bc2_import");
    expect(result).toBe("bc2_import");
  });

  it("auto-imports the user from prod and writes the map", async () => {
    const ctx = makeCtx();
    const inserts: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      if (/from import_map_prod_users/i.test(sql)) return { rows: [] };
      if (/from user_profiles where lower\(email\)/i.test(sql)) return { rows: [] };
      if (/insert into user_profiles/i.test(sql)) inserts.push({ sql, params });
      if (/insert into import_map_prod_users/i.test(sql)) inserts.push({ sql, params });
      return { rows: [] };
    });
    (ctx.prod.query as any) = vi.fn(() => ({
      rows: [{
        id: "prod-real-uuid",
        email: "alice@example.com",
        first_name: "Alice",
        last_name: null,
        avatar_url: null,
        job_title: null,
        timezone: null,
        bio: null,
      }],
    }));
    const result = await resolveUserRef(ctx, "prod-real-uuid");
    expect(result).toBe("prod-real-uuid");
    expect(inserts.some((i) => /insert into user_profiles/i.test(i.sql))).toBe(true);
    expect(inserts.some((i) => /insert into import_map_prod_users/i.test(i.sql))).toBe(true);
  });
});
