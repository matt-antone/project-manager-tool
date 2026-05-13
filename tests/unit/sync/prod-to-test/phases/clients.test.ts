// tests/unit/sync/prod-to-test/phases/clients.test.ts
import { describe, it, expect, vi } from "vitest";
import { runClientsPhase } from "@/lib/sync/prod-to-test/phases/clients";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(overrides: Partial<PhaseCtx> = {}): PhaseCtx {
  const prodQuery = vi.fn();
  const testQuery = vi.fn();
  const testConnect = vi.fn(async () => ({
    query: testQuery,
    release: vi.fn(),
  }));
  const watermarks = new Map();
  watermarks.set("clients", new Date(0));
  return {
    prod: { query: prodQuery } as any,
    test: { query: testQuery, connect: testConnect } as any,
    prodStorage: {} as any,
    testStorage: {} as any,
    watermarks,
    flags: { phase: null, limitPerPhase: null, noBackup: false, iKnowWhatImDoing: false },
    log: () => {},
    ...overrides,
  };
}

describe("runClientsPhase", () => {
  it("inserts a new client when no test row matches by code", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any)
      .mockResolvedValueOnce({
        rows: [
          { id: "11111111-1111-1111-1111-111111111111", code: "ACME", name: "Acme Inc", archived_at: null, dropbox_archive_status: "idle", archive_started_at: null, archive_error: null, github_repos: [], domains: [], created_at: new Date("2026-04-01T00:00:00Z") },
        ],
      });
    const testQuery = (ctx.test as any).query as ReturnType<typeof vi.fn>;
    testQuery.mockImplementation((sql: string) => {
      if (/begin/i.test(sql)) return { rows: [] };
      if (/commit/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_clients/i.test(sql)) return { rows: [] };
      if (/from clients where lower\(code\)/i.test(sql)) return { rows: [] };
      if (/insert into clients/i.test(sql)) return { rows: [] };
      if (/insert into import_map_prod_clients/i.test(sql)) return { rows: [] };
      return { rows: [] };
    });

    const result = await runClientsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.newWatermark.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("reuses existing test client (by code) and only writes the map row", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [
        { id: "22222222-2222-2222-2222-222222222222", code: "BETA", name: "Beta", archived_at: null, dropbox_archive_status: "idle", archive_started_at: null, archive_error: null, github_repos: [], domains: [], created_at: new Date("2026-04-02T00:00:00Z") },
      ],
    });
    const inserts: string[] = [];
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/insert into clients/i.test(sql)) inserts.push(sql);
      if (/from clients where lower\(code\)/i.test(sql)) {
        return { rows: [{ id: "99999999-9999-9999-9999-999999999999" }] };
      }
      if (/from import_map_prod_clients/i.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const result = await runClientsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(inserts).toHaveLength(0);
  });

  it("skips when import_map_prod_clients already has the prod id", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [
        { id: "33333333-3333-3333-3333-333333333333", code: "GAMMA", name: "Gamma", archived_at: null, dropbox_archive_status: "idle", archive_started_at: null, archive_error: null, github_repos: [], domains: [], created_at: new Date("2026-04-03T00:00:00Z") },
      ],
    });
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_clients/i.test(sql)) {
        return { rows: [{ local_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }] };
      }
      return { rows: [] };
    });
    const result = await runClientsPhase(ctx);
    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(0);
  });
});
