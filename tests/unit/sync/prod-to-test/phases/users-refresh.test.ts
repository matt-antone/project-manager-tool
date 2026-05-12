// tests/unit/sync/prod-to-test/phases/users-refresh.test.ts
import { describe, it, expect, vi } from "vitest";
import { runUsersPhaseRefresh } from "@/lib/sync/prod-to-test/phases/users";
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

describe("runUsersPhaseRefresh", () => {
  it("updates mutable fields on a mapped user", async () => {
    const ctx = makeCtx();

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/from import_map_prod_users/i.test(sql)) {
        return { rows: [{ prod_id: "prod-u1", local_id: "local-u1" }] };
      }
      return { rows: [] };
    });

    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: "prod-u1",
          email: "jane@example.com",
          first_name: "Jane",
          last_name: "Doe",
          avatar_url: "https://cdn.example.com/jane.jpg",
          job_title: "Developer",
          timezone: "America/Chicago",
          bio: "Updated bio",
          is_legacy: false,
          active: true,
          last_seen_at: new Date("2026-05-10T00:00:00Z"),
        },
      ],
    });

    const result = await runUsersPhaseRefresh(ctx);

    expect(result.scanned).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.newWatermark.getTime()).toBe(0);
    expect(result.kind).toBe("refresh");

    const updateCall = seen.find((s) => /update user_profiles/i.test(s.sql));
    expect(updateCall).toBeTruthy();
    expect(updateCall!.params[0]).toBe("local-u1");
    expect(updateCall!.params[1]).toBe("jane@example.com");
    expect(updateCall!.params[8]).toBe(false); // is_legacy
  });
});
