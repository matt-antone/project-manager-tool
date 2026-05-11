import { describe, it, expect, vi } from "vitest";
import {
  parseFlags,
  pickRetriable,
  RETRIABLE_REASONS,
  runRetry,
  type FailedFileRow,
  type RetryDeps,
} from "@/scripts/retry-failed-files";
import type { Bc2Attachment } from "@/lib/imports/bc2-fetcher";

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

// Test fixtures for runRetry
const ATT_100_1000 = { id: 1000, name: "A.png", byte_size: 1, url: "u1" } as unknown as Bc2Attachment;
const ATT_100_1001 = { id: 1001, name: "B.png", byte_size: 1, url: "u2" } as unknown as Bc2Attachment;
const ATT_200_2000 = { id: 2000, name: "C.png", byte_size: 1, url: "u3" } as unknown as Bc2Attachment;

const ROWS: FailedFileRow[] = [
  { bc2ProjectId: "100", bc2AttachmentId: "1000", filename: "A.png", reason: "fetch failed" },
  { bc2ProjectId: "100", bc2AttachmentId: "1001", filename: "B.png", reason: "Response failed with a 409 code" },
  { bc2ProjectId: "200", bc2AttachmentId: "2000", filename: "C.png", reason: "fetch failed" },
];

function fakeDeps(overrides: Partial<RetryDeps> = {}): RetryDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    flags: {
      hasBackup: true,
      auditCsvPath: "ignored.csv",
      dumpDir: "/tmp/dump",
      verbose: false,
    },
    readFailedFileRows: vi.fn(async () => ROWS),
    loadProjectInfo: vi.fn(async (bc2ProjectId: string) => ({
      bc2Id: Number(bc2ProjectId),
      localId: `local-${bc2ProjectId}`,
      name: `proj-${bc2ProjectId}`,
      storageDir: `/Projects/X/proj-${bc2ProjectId}`,
      archived: false,
    })),
    loadProjectAttachments: vi.fn(async (bc2ProjectId: string) =>
      bc2ProjectId === "100"
        ? [ATT_100_1000, ATT_100_1001]
        : [ATT_200_2000],
    ),
    loadPersonMap: vi.fn(async () => new Map<number, string>()),
    createJob: vi.fn(async () => "job-uuid"),
    finishJob: vi.fn(async () => undefined),
    importOne: vi.fn(async () => ({ status: "imported", localFileId: "fid" })),
    log: (s) => lines.push(s),
    err: (s) => lines.push(`ERR ${s}`),
    lines,
    ...overrides,
  };
}

describe("runRetry", () => {
  it("happy path: 3 retriable rows → 3 importOne calls, summary ok=3 failed=0, exit 0", async () => {
    const d = fakeDeps();
    const exit = await runRetry(d);
    expect(exit).toBe(0);
    expect(d.importOne).toHaveBeenCalledTimes(3);
    expect(d.lines.some((l) => l.includes("ok=3 failed=0"))).toBe(true);
  });

  it("zero retriable rows → 'nothing to retry', exit 0, no createJob", async () => {
    const d = fakeDeps({
      readFailedFileRows: vi.fn(async () => [
        { bc2ProjectId: "999", bc2AttachmentId: "9999", filename: "G.doc", reason: "Failed to parse URL from undefined" },
      ]),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(0);
    expect(d.createJob).not.toHaveBeenCalled();
    expect(d.lines.some((l) => l.includes("nothing to retry"))).toBe(true);
  });

  it("project not in import_map_projects → logs per attachment, exit 1", async () => {
    const d = fakeDeps({
      loadProjectInfo: vi.fn(async (bc2ProjectId: string) =>
        bc2ProjectId === "200" ? null : {
          bc2Id: Number(bc2ProjectId),
          localId: `local-${bc2ProjectId}`,
          name: `proj-${bc2ProjectId}`,
          storageDir: "/Projects/X/proj",
          archived: false,
        },
      ),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(1);
    expect(d.importOne).toHaveBeenCalledTimes(2); // 100's two
    expect(d.lines.some((l) => l.includes("ERR") && l.includes("200") && l.includes("project_not_mapped"))).toBe(true);
  });

  it("attachment not in dump → logged, exit 1", async () => {
    const d = fakeDeps({
      loadProjectAttachments: vi.fn(async (bc2ProjectId: string) =>
        bc2ProjectId === "100" ? [ATT_100_1000] : [ATT_200_2000], // 1001 missing
      ),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(1);
    expect(d.importOne).toHaveBeenCalledTimes(2); // 1000 + 2000
    expect(d.lines.some((l) => l.includes("ERR") && l.includes("1001") && l.includes("attachment_not_in_dump"))).toBe(true);
  });

  it("importOne throws for one → others run, exit 1, error in summary", async () => {
    const d = fakeDeps({
      importOne: vi.fn(async ({ attachment }: { attachment: Bc2Attachment }) => {
        if (attachment.id === 1001) throw new Error("download blew up");
        return { status: "imported", localFileId: "fid" };
      }),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(1);
    expect(d.importOne).toHaveBeenCalledTimes(3);
    expect(d.lines.some((l) => l.includes("ERR") && l.includes("1001") && l.includes("download blew up"))).toBe(true);
  });

  it("importOne returns {status:'failed',error:...} → counted as failed, exit 1", async () => {
    const d = fakeDeps({
      importOne: vi.fn(async ({ attachment }: { attachment: Bc2Attachment }) => {
        if (attachment.id === 1000) return { status: "failed", error: "still 409" };
        return { status: "imported", localFileId: "fid" };
      }),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(1);
    expect(d.lines.some((l) => l.includes("ok=2 failed=1"))).toBe(true);
    expect(d.lines.some((l) => l.includes("still 409"))).toBe(true);
  });

  it("importOne returns skipped_existing → counted as ok", async () => {
    const d = fakeDeps({
      importOne: vi.fn(async () => ({ status: "skipped_existing", localFileId: "fid" })),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(0);
    expect(d.lines.some((l) => l.includes("ok=3 failed=0"))).toBe(true);
  });
});
