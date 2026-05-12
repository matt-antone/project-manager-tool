// tests/unit/sync/prod-to-test/phases/clients-refresh.test.ts
import { describe, it, expect, vi } from "vitest";
import { runClientsPhaseRefresh } from "@/lib/sync/prod-to-test/phases/clients";
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

describe("runClientsPhaseRefresh", () => {
  it("updates mutable fields on a mapped client", async () => {
    const ctx = makeCtx();

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/from import_map_prod_clients/i.test(sql)) {
        return { rows: [{ prod_id: "prod-c1", local_id: "local-c1" }] };
      }
      return { rows: [] };
    });

    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: "prod-c1",
          name: "Acme Updated",
          archived_at: null,
          dropbox_archive_status: "archived",
          archive_started_at: new Date("2026-05-01T00:00:00Z"),
          archive_error: null,
          github_repos: ["org/repo"],
          domains: ["acme.com"],
        },
      ],
    });

    const result = await runClientsPhaseRefresh(ctx);

    expect(result.scanned).toBe(1);
    expect(result.inserted).toBe(1); // "inserted" = rows updated in refresh
    expect(result.failed).toBe(0);
    expect(result.newWatermark.getTime()).toBe(0);
    expect(result.kind).toBe("refresh");

    const updateCall = seen.find((s) => /update clients/i.test(s.sql));
    expect(updateCall).toBeTruthy();
    expect(updateCall!.params[0]).toBe("local-c1");
    expect(updateCall!.params[1]).toBe("Acme Updated");
    expect(updateCall!.params[3]).toBe("archived"); // dropbox_archive_status
  });
});
