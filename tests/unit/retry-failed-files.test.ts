import { describe, it, expect } from "vitest";
import {
  parseFlags,
  pickRetriable,
  RETRIABLE_REASONS,
  type FailedFileRow,
} from "@/scripts/retry-failed-files";

describe("parseFlags", () => {
  it("requires --i-have-a-backup", () => {
    expect(() => parseFlags([])).toThrow(/--i-have-a-backup/);
  });

  it("parses defaults", () => {
    const f = parseFlags(["--i-have-a-backup"]);
    expect(f).toEqual({
      hasBackup: true,
      auditCsvPath: "tmp/audit/files.csv",
      dumpDir: process.env.BASECAMP_DUMP_DIR ?? "/Volumes/Spare/basecamp-dump",
      verbose: false,
    });
  });

  it("parses overrides", () => {
    const f = parseFlags([
      "--i-have-a-backup",
      "--audit-csv=/tmp/a.csv",
      "--dump-dir=/tmp/d",
      "--verbose",
    ]);
    expect(f.auditCsvPath).toBe("/tmp/a.csv");
    expect(f.dumpDir).toBe("/tmp/d");
    expect(f.verbose).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(() =>
      parseFlags(["--i-have-a-backup", "--bogus"]),
    ).toThrow(/Unknown flag/);
  });
});

describe("RETRIABLE_REASONS", () => {
  it("contains exactly the two transient reasons", () => {
    expect(RETRIABLE_REASONS.size).toBe(2);
    expect(RETRIABLE_REASONS.has("fetch failed")).toBe(true);
    expect(RETRIABLE_REASONS.has("Response failed with a 409 code")).toBe(true);
  });
});

describe("pickRetriable", () => {
  const sample: FailedFileRow[] = [
    { bc2ProjectId: "100", bc2AttachmentId: "1000", filename: "A", reason: "fetch failed" },
    { bc2ProjectId: "100", bc2AttachmentId: "1001", filename: "B", reason: "Response failed with a 409 code" },
    { bc2ProjectId: "200", bc2AttachmentId: "2000", filename: "C", reason: "Failed to parse URL from undefined" },
    { bc2ProjectId: "300", bc2AttachmentId: "3000", filename: "D", reason: "some other failure" },
  ];

  it("keeps only fetch-failed and 409 rows", () => {
    const r = pickRetriable(sample);
    expect(r.map((x) => x.bc2AttachmentId)).toEqual(["1000", "1001"]);
  });

  it("returns empty when nothing matches", () => {
    const r = pickRetriable([sample[2], sample[3]]);
    expect(r).toEqual([]);
  });
});
