import { describe, it, expect, vi } from "vitest";
import { resolve } from "path";
import { reconStrandedComments } from "@/lib/imports/migration/stranded-comments";
import type { Query } from "@/lib/imports/migration/jobs";

const FIXTURE_DUMP = resolve(__dirname, "../fixtures/bc2-dump-stranded");

interface FakeRow { rows: unknown[]; rowCount: number }

function makeFakeQ(handlers: Array<(sql: string, params?: unknown[]) => FakeRow | null>): Query {
  return (async (sql: string, params?: unknown[]) => {
    for (const h of handlers) {
      const res = h(sql, params);
      if (res) return res as never;
    }
    return { rows: [], rowCount: 0 } as never;
  }) as Query;
}

describe("reconStrandedComments — happy path", () => {
  it("inserts the missing comment for one mapped thread", async () => {
    const q = makeFakeQ([
      (sql, p) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "local-project-uuid" }], rowCount: 1 }
        : null,
      (sql, p) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "local-thread-uuid" }], rowCount: 1 }
        : null,
      (sql, p) => sql.includes("from import_map_comments")
        ? { rows: [], rowCount: 0 }
        : null,
      (sql) => sql.startsWith("insert into import_map_comments")
        ? { rows: [], rowCount: 1 }
        : null,
      (sql) => sql.startsWith("insert into import_logs")
        ? { rows: [], rowCount: 1 }
        : null,
    ]);

    const createComment = vi.fn().mockResolvedValue({ id: "local-comment-uuid" });

    const result = await reconStrandedComments({
      q,
      jobId: "job-1",
      dumpDir: FIXTURE_DUMP,
      projectIds: [100],
      personMap: new Map([[9001, "user-alice"], [9002, "user-bob"]]),
      createComment,
    });

    expect(createComment).toHaveBeenCalledTimes(2);
    expect(result.totals.success).toBe(2);
    expect(result.totals.failed).toBe(0);
    expect(result.totals.skipped_already_mapped).toBe(0);
    expect(result.perProject[0]).toMatchObject({
      bc2Id: 100,
      localId: "local-project-uuid",
      success: 2,
    });
  });
});

describe("reconStrandedComments — idempotency", () => {
  it("skips comments already in import_map_comments without calling createComment", async () => {
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "lt" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_comments")
        ? { rows: [{ local_comment_id: "lc" }], rowCount: 1 } : null,
    ]);
    const createComment = vi.fn();

    const result = await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [100], personMap: new Map(), createComment,
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(result.totals.success).toBe(0);
    expect(result.totals.skipped_already_mapped).toBe(2);
  });
});

describe("reconStrandedComments — orphan-no-thread", () => {
  it("logs failed and skips when import_map_threads has no row", async () => {
    const inserts: Array<{ sql: string; params: unknown[] }> = [];
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [], rowCount: 0 } : null,
      (sql) => sql.includes("from import_map_comments")
        ? { rows: [], rowCount: 0 } : null,
      (sql, p) => {
        if (sql.startsWith("insert into import_logs")) {
          inserts.push({ sql, params: p ?? [] });
          return { rows: [], rowCount: 1 };
        }
        return null;
      },
    ]);
    const createComment = vi.fn();

    const result = await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [101], personMap: new Map(), createComment,
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(result.totals.skipped_orphan_no_thread).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toEqual([
      "j", "comment", "6001", "failed", "orphan_no_thread", "dump",
    ]);
  });
});

describe("reconStrandedComments — unsupported topicable", () => {
  it("silently counts Calendar topics without logRecord or createComment", async () => {
    let logInserts = 0;
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => {
        if (sql.startsWith("insert into import_logs")) { logInserts++; return { rows: [], rowCount: 1 }; }
        return null;
      },
    ]);
    const createComment = vi.fn();

    const result = await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [102], personMap: new Map(), createComment,
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(logInserts).toBe(0);
    expect(result.totals.skipped_unsupported_topicable).toBe(1);
  });
});

describe("reconStrandedComments — unmapped project", () => {
  it("skips the project and continues to the next when import_map_projects misses", async () => {
    const q = makeFakeQ([
      (sql, p) => {
        if (sql.includes("from import_map_projects")) {
          const id = (p as string[])[0];
          return id === "999"
            ? { rows: [], rowCount: 0 }
            : { rows: [{ local_project_id: "lp" }], rowCount: 1 };
        }
        return null;
      },
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "lt" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_comments")
        ? { rows: [], rowCount: 0 } : null,
      (sql) => sql.startsWith("insert into import_map_comments") ? { rows: [], rowCount: 1 } : null,
      (sql) => sql.startsWith("insert into import_logs") ? { rows: [], rowCount: 1 } : null,
    ]);
    const createComment = vi.fn().mockResolvedValue({ id: "lc" });

    const result = await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [999, 100], personMap: new Map([[9001, "u1"], [9002, "u2"]]), createComment,
    });

    expect(result.totals.projects_skipped_unmapped).toBe(1);
    expect(result.perProject[0]).toMatchObject({ bc2Id: 999, localId: null });
    expect(result.perProject[1].bc2Id).toBe(100);
    expect(result.totals.success).toBe(2);
  });
});

describe("reconStrandedComments — author fallback", () => {
  it("uses dry_<id> for unmapped creator and dry_unknown when creator is absent", async () => {
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "lt" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_comments")
        ? { rows: [], rowCount: 0 } : null,
      (sql) => sql.startsWith("insert into import_map_comments") ? { rows: [], rowCount: 1 } : null,
      (sql) => sql.startsWith("insert into import_logs") ? { rows: [], rowCount: 1 } : null,
    ]);
    const createComment = vi.fn().mockResolvedValue({ id: "lc" });

    await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [103], personMap: new Map(), createComment,
    });

    expect(createComment.mock.calls.map((c) => c[0].authorUserId)).toEqual([
      "dry_9999",
      "dry_unknown",
    ]);
  });
});

describe("reconStrandedComments — missing detail", () => {
  it("does not throw when topic detail JSON is missing and counts no work", async () => {
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "lt" }], rowCount: 1 } : null,
    ]);
    const createComment = vi.fn();

    const result = await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [104], personMap: new Map(), createComment,
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(result.totals.success).toBe(0);
    expect(result.totals.failed).toBe(0);
  });
});
