import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { runSync } from "../../../lib/imports/sync-prod-to-test/sync-orchestrator";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROD = process.env.SYNC_TEST_PROD_DATABASE_URL;
const TEST = process.env.SYNC_TEST_DATABASE_URL;
const enabled = !!PROD && !!TEST;

(enabled ? describe : describe.skip)("sync orchestrator (integration)", () => {
  let prod: Pool, test: Pool;

  beforeAll(async () => {
    prod = new Pool({ connectionString: PROD, ssl: { rejectUnauthorized: false } });
    test = new Pool({ connectionString: TEST, ssl: { rejectUnauthorized: false } });
  });
  afterAll(async () => {
    await prod?.end();
    await test?.end();
  });

  it("dry-run processes post-cutoff projects and is idempotent on re-run", async () => {
    const cutoff = new Date("2026-04-24T00:00:00Z");
    const dir1 = mkdtempSync(join(tmpdir(), "sync-")) + "/run1";
    const dir2 = mkdtempSync(join(tmpdir(), "sync-")) + "/run2";

    const outcomes1 = await runSync({ prod, test }, {
      cutoff, dryRun: true, skipFiles: true,
      runId: "test-run-1", extractDir: dir1,
    });
    expect(outcomes1.length).toBeGreaterThan(0);
    for (const o of outcomes1) expect(o.errors).toEqual([]);

    const outcomes2 = await runSync({ prod, test }, {
      cutoff, dryRun: true, skipFiles: true,
      runId: "test-run-2", extractDir: dir2,
    });
    expect(outcomes2.length).toBe(outcomes1.length);
  }, 60_000);
});
