import { describe, it, expect } from "vitest";
import { parseFlags, DEFAULT_PROJECT_IDS } from "@/scripts/recon-stranded-comments";

describe("parseFlags", () => {
  it("requires --i-have-a-backup", () => {
    expect(() => parseFlags([])).toThrow(/--i-have-a-backup/);
  });

  it("parses defaults", () => {
    const f = parseFlags(["--i-have-a-backup"]);
    expect(f).toEqual({
      hasBackup: true,
      projectIds: DEFAULT_PROJECT_IDS,
      dumpDir: process.env.BASECAMP_DUMP_DIR ?? "/Volumes/Spare/basecamp-dump",
    });
  });

  it("parses --projects=<csv>", () => {
    const f = parseFlags(["--i-have-a-backup", "--projects=111,222,333"]);
    expect(f.projectIds).toEqual([111, 222, 333]);
  });

  it("parses --dump-dir=<path>", () => {
    const f = parseFlags(["--i-have-a-backup", "--dump-dir=/tmp/d"]);
    expect(f.dumpDir).toBe("/tmp/d");
  });

  it("rejects unknown flags", () => {
    expect(() => parseFlags(["--i-have-a-backup", "--bogus"])).toThrow(/Unknown flag/);
  });

  it("rejects non-numeric project ids", () => {
    expect(() => parseFlags(["--i-have-a-backup", "--projects=abc"])).toThrow(/invalid project id/i);
  });
});

describe("DEFAULT_PROJECT_IDS", () => {
  it("matches the six known stranded-comment projects", () => {
    expect(DEFAULT_PROJECT_IDS).toEqual([
      12579434, 12450051, 12450414, 12580070, 12450632, 12450066,
    ]);
  });
});
