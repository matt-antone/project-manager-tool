// tests/unit/sync/prod-to-test/phases/threads-refresh.test.ts
import { describe, it, expect, vi } from "vitest";
import { runThreadsPhaseRefresh } from "@/lib/sync/prod-to-test/phases/threads";
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

describe("runThreadsPhaseRefresh", () => {
  it("updates title/body/edited_at on a mapped thread", async () => {
    const ctx = makeCtx();

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/from import_map_prod_threads/i.test(sql)) {
        return { rows: [{ prod_id: "prod-t1", local_id: "local-t1" }] };
      }
      return { rows: [] };
    });

    const editedAt = new Date("2026-05-10T12:00:00Z");
    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: "prod-t1",
          title: "Updated Thread Title",
          body_markdown: "# Updated\nNew content here.",
          body_html: "<h1>Updated</h1><p>New content here.</p>",
          edited_at: editedAt,
        },
      ],
    });

    const result = await runThreadsPhaseRefresh(ctx);

    expect(result.scanned).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.newWatermark.getTime()).toBe(0);
    expect(result.kind).toBe("refresh");

    const updateCall = seen.find((s) => /update discussion_threads/i.test(s.sql));
    expect(updateCall).toBeTruthy();
    expect(updateCall!.params[0]).toBe("local-t1");
    expect(updateCall!.params[1]).toBe("Updated Thread Title");
    expect(updateCall!.params[4]).toBe(editedAt);
  });
});
