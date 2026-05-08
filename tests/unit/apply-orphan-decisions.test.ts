import { describe, it, expect, vi } from "vitest";
import {
  parseFlags,
  runApply,
  type ApplyDeps,
} from "@/scripts/apply-orphan-decisions";
import type { OrphanDecision, ApplyOutcome } from "@/lib/imports/orphans/types";

const DECISIONS: OrphanDecision[] = [
  { bc2Id: "100", title: "Some Project", action: "assign", code: "ABC", clientName: "" },
  { bc2Id: "200", title: "Other Project", action: "create", code: "NEW", clientName: "New Client" },
  { bc2Id: "300", title: "Skip Me", action: "skip", code: "", clientName: "" },
];

function fakeDeps(overrides: Partial<ApplyDeps> = {}): ApplyDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    flags: {
      decisionsPath: "decisions.csv",
      hasBackup: true,
      runPhases: false,
      dryRun: false,
      dumpDir: "/tmp/dump",
      verbose: false,
    },
    readDecisionsFile: vi.fn(async () => ({
      decisions: DECISIONS,
      errors: [],
    })),
    loadDumpProjects: vi.fn(async () =>
      new Map(DECISIONS.map((d) => [
        d.bc2Id,
        {
          bc2Id: Number(d.bc2Id),
          title: d.title,
          archived: true,
          createdAt: "2018-01-01T00:00:00Z",
          updatedAt: null,
          description: null,
        },
      ])),
    ),
    createJob: vi.fn(async () => "job-uuid"),
    finishJob: vi.fn(async () => undefined),
    applyOne: vi.fn(async ({ decision }): Promise<ApplyOutcome> => {
      if (decision.action === "assign") return { status: "assigned", localProjectId: "p100", clientId: "c-abc" };
      if (decision.action === "create") return { status: "created", localProjectId: "p200", clientId: "c-new" };
      return { status: "skipped" };
    }),
    runPhasesForProjects: vi.fn(async () => ({ ok: 0, failed: 0 })),
    log: (s: string) => lines.push(s),
    err: (s: string) => lines.push(`ERR ${s}`),
    lines,
    ...overrides,
  };
}

describe("parseFlags", () => {
  it("requires --i-have-a-backup", () => {
    expect(() => parseFlags(["--decisions=x.csv"])).toThrow(/--i-have-a-backup/);
  });

  it("parses required + optional flags", () => {
    const f = parseFlags([
      "--decisions=x.csv",
      "--i-have-a-backup",
      "--run-phases",
      "--dry-run",
      "--dump-dir=/tmp/d",
      "--verbose",
    ]);
    expect(f).toEqual({
      decisionsPath: "x.csv",
      hasBackup: true,
      runPhases: true,
      dryRun: true,
      dumpDir: "/tmp/d",
      verbose: true,
    });
  });

  it("defaults", () => {
    const f = parseFlags(["--i-have-a-backup"]);
    expect(f.decisionsPath).toBe("docs/imports/bc2-orphan-decisions.csv");
    expect(f.runPhases).toBe(false);
    expect(f.dryRun).toBe(false);
  });

  it("rejects unknown flags", () => {
    expect(() =>
      parseFlags(["--i-have-a-backup", "--bogus"]),
    ).toThrow(/Unknown flag/);
  });
});

describe("runApply (mapping)", () => {
  it("happy path: 3 decisions → 3 applyOne calls, summary, exit 0", async () => {
    const d = fakeDeps();
    const exit = await runApply(d);
    expect(exit).toBe(0);
    expect(d.applyOne).toHaveBeenCalledTimes(3);
    expect(d.lines.some((l) => l.includes("assigned=1 created=1 skipped=1"))).toBe(true);
  });

  it("invalid rows → exits 1 before opening pool (no createJob)", async () => {
    const d = fakeDeps({
      readDecisionsFile: vi.fn(async () => ({
        decisions: [],
        errors: [{ rowNumber: 2, bc2Id: "100", message: "assign requires a non-empty code" }],
      })),
    });
    const exit = await runApply(d);
    expect(exit).toBe(1);
    expect(d.createJob).not.toHaveBeenCalled();
    expect(d.lines.some((l) => l.startsWith("ERR row 2") && l.includes("non-empty code"))).toBe(true);
  });

  it("dump project missing for a bc2_id → row error, continue", async () => {
    const d = fakeDeps({
      loadDumpProjects: vi.fn(async () =>
        new Map(DECISIONS.slice(0, 2).map((decision) => [
          decision.bc2Id,
          { bc2Id: Number(decision.bc2Id), title: decision.title, archived: true, createdAt: "2018-01-01T00:00:00Z", updatedAt: null, description: null },
        ])),
      ),
    });
    const exit = await runApply(d);
    expect(exit).toBe(1);
    expect(d.applyOne).toHaveBeenCalledTimes(2); // 100 and 200; 300 missing skipped
    expect(d.lines.some((l) => l.includes("ERR") && l.includes("300") && l.includes("not found in dump"))).toBe(true);
  });

  it("applyOne throws ClientNotFoundError for one row → others continue, exit 1", async () => {
    const d = fakeDeps({
      applyOne: vi.fn(async ({ decision }): Promise<ApplyOutcome> => {
        if (decision.bc2Id === "100") {
          throw Object.assign(new Error("No client found with code='ABC'"), { name: "ClientNotFoundError" });
        }
        if (decision.action === "create") return { status: "created", localProjectId: "p200", clientId: "c-new" };
        return { status: "skipped" };
      }),
    });
    const exit = await runApply(d);
    expect(exit).toBe(1);
    expect(d.applyOne).toHaveBeenCalledTimes(3);
    expect(d.lines.some((l) => l.includes("ERR 100") && l.includes("No client"))).toBe(true);
    expect(d.lines.some((l) => l.includes("created=1 skipped=1"))).toBe(true);
  });

  it("already_mapped is reported as no-op", async () => {
    const d = fakeDeps({
      applyOne: vi.fn(async (): Promise<ApplyOutcome> => ({
        status: "already_mapped",
        localProjectId: "p999",
      })),
    });
    const exit = await runApply(d);
    expect(exit).toBe(0);
    expect(d.lines.some((l) => l.includes("already_mapped=3"))).toBe(true);
  });
});

describe("runApply (--run-phases)", () => {
  it("calls runPhasesForProjects with the assigned + created projects only", async () => {
    const d = fakeDeps({
      flags: {
        decisionsPath: "decisions.csv",
        hasBackup: true,
        runPhases: true,
        dryRun: false,
        dumpDir: "/tmp/dump",
        verbose: false,
      },
    });
    const exit = await runApply(d);
    expect(exit).toBe(0);
    expect(d.runPhasesForProjects).toHaveBeenCalledTimes(1);
    const call = (d.runPhasesForProjects as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      jobId: string;
      mapped: Array<{ bc2Id: number }>;
    };
    expect(call.mapped.map((m) => m.bc2Id)).toEqual([100, 200]); // skip excluded
  });

  it("phases report failures → exit 1", async () => {
    const d = fakeDeps({
      flags: {
        decisionsPath: "decisions.csv",
        hasBackup: true,
        runPhases: true,
        dryRun: false,
        dumpDir: "/tmp/dump",
        verbose: false,
      },
      runPhasesForProjects: vi.fn(async () => ({ ok: 1, failed: 1 })),
    });
    const exit = await runApply(d);
    expect(exit).toBe(1);
  });
});
