// tests/unit/sync/prod-to-test/phases/users.test.ts
import { describe, it, expect, vi } from "vitest";
import { runUsersPhase } from "@/lib/sync/prod-to-test/phases/users";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(): PhaseCtx {
  const watermarks = new Map();
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

describe("runUsersPhase", () => {
  it("matches by email when existing test user found", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [{
        id: "prod-user-1",
        email: "Alice@Example.com",
        first_name: "Alice",
        last_name: "Z",
        avatar_url: null,
        job_title: null,
        timezone: null,
        bio: null,
        is_legacy: false,
        active: true,
        created_at: new Date("2026-04-01T00:00:00Z"),
        last_seen_at: new Date("2026-04-01T00:00:00Z"),
      }],
    });
    const inserts: string[] = [];
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_users/i.test(sql)) return { rows: [] };
      if (/from user_profiles where lower\(email\)/i.test(sql)) {
        return { rows: [{ id: "existing-local-user" }] };
      }
      if (/insert into user_profiles/i.test(sql)) inserts.push(sql);
      return { rows: [] };
    });
    const result = await runUsersPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(inserts).toHaveLength(0);
  });

  it("inserts a new user_profile using prod's id when no email match", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [{
        id: "prod-user-2",
        email: "bob@example.com",
        first_name: "Bob",
        last_name: null,
        avatar_url: null,
        job_title: null,
        timezone: null,
        bio: null,
        is_legacy: false,
        active: true,
        created_at: new Date("2026-04-02T00:00:00Z"),
        last_seen_at: new Date("2026-04-02T00:00:00Z"),
      }],
    });
    const inserts: Array<[string, any[]]> = [];
    (ctx.test as any).query = vi.fn((sql: string, params?: any[]) => {
      if (/from import_map_prod_users/i.test(sql)) return { rows: [] };
      if (/from user_profiles where lower\(email\)/i.test(sql)) return { rows: [] };
      if (/insert into user_profiles/i.test(sql)) inserts.push([sql, params ?? []]);
      return { rows: [] };
    });
    const result = await runUsersPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1][0]).toBe("prod-user-2");
  });
});
