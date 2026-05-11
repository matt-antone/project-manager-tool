// tests/unit/audit-diff.test.ts
import { describe, it, expect } from "vitest";
import { classifyEntity, loadDbState } from "@/lib/imports/audit/diff";
import type { DbState } from "@/lib/imports/audit/types";

function emptyState(): DbState {
  return {
    peopleMap: new Map(),
    projectsMap: new Map(),
    threadsMap: new Map(),
    commentsMap: new Map(),
    filesMap: new Map(),
    logs: new Map(),
  };
}

describe("classifyEntity", () => {
  it("status=mapped when id present in the map", () => {
    const s = emptyState();
    s.projectsMap.set("100", "uuid-1");
    const out = classifyEntity({ kind: "projects", bc2Id: "100", state: s });
    expect(out).toEqual({ status: "mapped", localId: "uuid-1", reason: "" });
  });

  it("status=skipped_unsupported when log message starts with skipped_topicable_type=", () => {
    const s = emptyState();
    s.logs.set("thread:50", { status: "failed", message: "skipped_topicable_type=CalendarEvent" });
    const out = classifyEntity({ kind: "topics", bc2Id: "50", state: s });
    expect(out.status).toBe("skipped_unsupported");
    expect(out.reason).toBe("skipped_topicable_type=CalendarEvent");
  });

  it("status=skipped_existing when log message equals skipped_existing", () => {
    const s = emptyState();
    s.logs.set("file:777", { status: "success", message: "skipped_existing" });
    const out = classifyEntity({ kind: "files", bc2Id: "777", state: s });
    expect(out.status).toBe("skipped_existing");
    expect(out.reason).toBe("skipped_existing");
  });

  it("status=failed for other failed log entries, copies message to reason", () => {
    const s = emptyState();
    s.logs.set("file:778", { status: "failed", message: "Failed to parse URL from undefined" });
    const out = classifyEntity({ kind: "files", bc2Id: "778", state: s });
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("Failed to parse URL from undefined");
  });

  it("status=missing when neither map nor log has the id", () => {
    const s = emptyState();
    const out = classifyEntity({ kind: "comments", bc2Id: "999", state: s });
    expect(out).toEqual({ status: "missing", localId: "", reason: "" });
  });

  it("uses the correct record_type prefix per entity kind", () => {
    const s = emptyState();
    s.logs.set("project:42", { status: "failed", message: "orphan" });
    const out = classifyEntity({ kind: "projects", bc2Id: "42", state: s });
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("orphan");
  });
});

describe("loadDbState", () => {
  it("hydrates all five maps + logs map from query results", async () => {
    const calls: string[] = [];
    const fakeQ = (async <T>(sql: string): Promise<{ rows: T[] }> => {
      calls.push(sql.trim().split(/\s+/).slice(0, 4).join(" "));
      if (sql.includes("from import_map_people")) {
        return { rows: [{ basecamp_person_id: "1", local_user_profile_id: "u1" }] as T[] };
      }
      if (sql.includes("from import_map_projects")) {
        return { rows: [{ basecamp_project_id: "100", local_project_id: "p1" }] as T[] };
      }
      if (sql.includes("from import_map_threads")) {
        return { rows: [{ basecamp_thread_id: "50", local_thread_id: "t1" }] as T[] };
      }
      if (sql.includes("from import_map_comments")) {
        return { rows: [{ basecamp_comment_id: "60", local_comment_id: "c1" }] as T[] };
      }
      if (sql.includes("from import_map_files")) {
        return { rows: [{ basecamp_file_id: "70", local_file_id: "f1" }] as T[] };
      }
      if (sql.includes("from import_logs")) {
        return {
          rows: [
            { record_type: "thread", source_record_id: "999", status: "failed", message: "skipped_topicable_type=Todo" },
          ] as T[],
        };
      }
      return { rows: [] as T[] };
    }) as unknown as Parameters<typeof loadDbState>[0];

    const state = await loadDbState(fakeQ);

    expect(state.peopleMap.get("1")).toBe("u1");
    expect(state.projectsMap.get("100")).toBe("p1");
    expect(state.threadsMap.get("50")).toBe("t1");
    expect(state.commentsMap.get("60")).toBe("c1");
    expect(state.filesMap.get("70")).toBe("f1");
    expect(state.logs.get("thread:999")).toEqual({
      status: "failed",
      message: "skipped_topicable_type=Todo",
    });
    expect(calls.length).toBe(6);
  });
});
