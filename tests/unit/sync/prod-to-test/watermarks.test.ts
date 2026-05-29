import { describe, it, expect, vi } from "vitest";
import { loadWatermarks, saveWatermark, ENTITY_NAMES } from "@/lib/sync/prod-to-test/watermarks";

function fakePool(rows: Array<{ entity: string; last_synced_at: Date }>) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as any;
}

describe("loadWatermarks", () => {
  it("returns an epoch-zero default for entities with no row", async () => {
    const pool = fakePool([]);
    const wm = await loadWatermarks(pool);
    for (const e of ENTITY_NAMES) {
      expect(wm.get(e)?.getTime()).toBe(0);
    }
  });

  it("returns the stored timestamp when present", async () => {
    const t = new Date("2026-05-01T00:00:00Z");
    const pool = fakePool([{ entity: "projects", last_synced_at: t }]);
    const wm = await loadWatermarks(pool);
    expect(wm.get("projects")?.toISOString()).toBe(t.toISOString());
    expect(wm.get("clients")?.getTime()).toBe(0);
  });
});

describe("saveWatermark", () => {
  it("upserts the row for that entity", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as any;
    const t = new Date("2026-05-12T00:00:00Z");
    await saveWatermark(pool, "projects", t);
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/insert into sync_prod_watermarks/i);
    expect(sql).toMatch(/on conflict \(entity\) do update/i);
    expect(params).toEqual(["projects", t]);
  });
});
