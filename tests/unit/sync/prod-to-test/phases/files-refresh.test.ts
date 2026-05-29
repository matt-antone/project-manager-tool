// tests/unit/sync/prod-to-test/phases/files-refresh.test.ts
import { describe, it, expect, vi } from "vitest";
import { runFilesPhaseRefresh } from "@/lib/sync/prod-to-test/phases/files";
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

describe("runFilesPhaseRefresh", () => {
  it("updates filename/mime_type/thumbnail_url/bc_attachment_id on a mapped file", async () => {
    const ctx = makeCtx();

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/from import_map_prod_files/i.test(sql)) {
        return { rows: [{ prod_id: "prod-f1", local_id: "local-f1" }] };
      }
      return { rows: [] };
    });

    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: "prod-f1",
          filename: "report-v2.pdf",
          mime_type: "application/pdf",
          thumbnail_url: "https://cdn.example.com/thumb/report-v2.jpg",
          bc_attachment_id: "att-9999",
        },
      ],
    });

    const result = await runFilesPhaseRefresh(ctx);

    expect(result.scanned).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.newWatermark.getTime()).toBe(0);
    expect(result.kind).toBe("refresh");

    const updateCall = seen.find((s) => /update project_files/i.test(s.sql));
    expect(updateCall).toBeTruthy();
    expect(updateCall!.params[0]).toBe("local-f1");
    expect(updateCall!.params[1]).toBe("report-v2.pdf");
    expect(updateCall!.params[2]).toBe("application/pdf");
    expect(updateCall!.params[3]).toBe("https://cdn.example.com/thumb/report-v2.jpg");
    expect(updateCall!.params[4]).toBe("att-9999");
  });
});
