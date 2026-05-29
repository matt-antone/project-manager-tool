import { describe, it, expect } from "vitest";
import { toPoolerUrl, buildBackupPath } from "@/lib/sync/prod-to-test/backup";

describe("toPoolerUrl", () => {
  it("rewrites :6543 to :5432", () => {
    expect(
      toPoolerUrl("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres")
    ).toBe("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres");
  });

  it("leaves :5432 unchanged", () => {
    expect(
      toPoolerUrl("postgresql://u:p@host:5432/postgres")
    ).toBe("postgresql://u:p@host:5432/postgres");
  });

  it("leaves urls with no port unchanged", () => {
    expect(toPoolerUrl("postgresql://u:p@host/postgres"))
      .toBe("postgresql://u:p@host/postgres");
  });
});

describe("buildBackupPath", () => {
  it("formats path as backups/sync-prod-YYYYMMDD-HHMMSS.dump", () => {
    const ts = new Date("2026-05-12T15:04:05Z");
    expect(buildBackupPath("backups", ts))
      .toMatch(/^backups\/sync-prod-20260512-\d{6}\.dump$/);
  });
});
