import { describe, it, expect, vi } from "vitest";
import { applyDecision } from "@/lib/imports/orphans/apply";
import { ClientNotFoundError, type OrphanDecision } from "@/lib/imports/orphans/types";

type FakeQ = ReturnType<typeof makeFakeQ>;

function makeFakeQ() {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const responses: Map<string, { rows: Record<string, unknown>[] }> = new Map();
  const q = (async <T>(sql: string, values?: unknown[]) => {
    calls.push({ sql: sql.trim().split(/\s+/).slice(0, 6).join(" "), values });
    for (const [matcher, response] of responses) {
      if (sql.includes(matcher)) {
        return { rows: response.rows as T[] };
      }
    }
    return { rows: [] as T[] };
  }) as <T>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
  return {
    q,
    calls,
    when(matcher: string, rows: Record<string, unknown>[]) {
      responses.set(matcher, { rows });
    },
  };
}

const baseDumpProject = {
  bc2Id: 100,
  title: "Some Project",
  archived: true,
  createdAt: "2018-01-01T00:00:00Z",
  updatedAt: "2018-06-01T00:00:00Z",
  description: null,
};

const decisionAssign: OrphanDecision = {
  bc2Id: "100",
  title: "Some Project",
  action: "assign",
  code: "ABC",
  clientName: "",
};

describe("applyDecision", () => {
  it("assign: looks up client, inserts project, inserts import_map_projects", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", []); // not yet mapped
    f.when("from clients where lower(code)", [{ id: "client-uuid", code: "ABC" }]);
    f.when("coalesce(max(project_seq)", [{ next_seq: 5 }]);
    f.when("insert into projects", [{ id: "project-uuid" }]);

    const out = await applyDecision({
      q: f.q,
      decision: decisionAssign,
      dumpProject: baseDumpProject,
      jobId: "job-1",
    });

    expect(out).toEqual({ status: "assigned", localProjectId: "project-uuid", clientId: "client-uuid" });
    expect(f.calls.some((c) => c.sql.startsWith("insert into import_map_projects"))).toBe(true);
  });

  it("assign: throws ClientNotFoundError when code missing", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", []);
    f.when("from clients where lower(code)", []);

    await expect(
      applyDecision({
        q: f.q,
        decision: decisionAssign,
        dumpProject: baseDumpProject,
        jobId: "job-1",
      }),
    ).rejects.toBeInstanceOf(ClientNotFoundError);
  });

  it("create: inserts client, inserts project, inserts import_map_projects", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", []);
    f.when("from clients where lower(code)", []); // client absent
    f.when("insert into clients", [{ id: "new-client-uuid" }]);
    f.when("coalesce(max(project_seq)", [{ next_seq: 1 }]);
    f.when("insert into projects", [{ id: "project-uuid" }]);

    const out = await applyDecision({
      q: f.q,
      decision: { ...decisionAssign, action: "create", code: "NEW", clientName: "New Client" },
      dumpProject: baseDumpProject,
      jobId: "job-1",
    });

    expect(out).toEqual({
      status: "created",
      localProjectId: "project-uuid",
      clientId: "new-client-uuid",
    });
    expect(f.calls.some((c) => c.sql.startsWith("insert into clients"))).toBe(true);
  });

  it("create: reuses existing client when code already present", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", []);
    f.when("from clients where lower(code)", [{ id: "existing-uuid" }]);
    f.when("coalesce(max(project_seq)", [{ next_seq: 1 }]);
    f.when("insert into projects", [{ id: "project-uuid" }]);

    const out = await applyDecision({
      q: f.q,
      decision: { ...decisionAssign, action: "create", code: "NEW", clientName: "New Client" },
      dumpProject: baseDumpProject,
      jobId: "job-1",
    });

    expect(out.status).toBe("created");
    expect((out as { clientId: string }).clientId).toBe("existing-uuid");
    expect(f.calls.some((c) => c.sql.startsWith("insert into clients"))).toBe(false);
  });

  it("skip: writes import_logs row, no map insert", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", []);

    const out = await applyDecision({
      q: f.q,
      decision: { ...decisionAssign, action: "skip", code: "", clientName: "" },
      dumpProject: baseDumpProject,
      jobId: "job-1",
    });

    expect(out).toEqual({ status: "skipped" });
    expect(f.calls.some((c) => c.sql.startsWith("insert into import_logs"))).toBe(true);
    expect(f.calls.some((c) => c.sql.startsWith("insert into import_map_projects"))).toBe(false);
  });

  it("returns already_mapped when import_map_projects has the bc2_id", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", [{ local_project_id: "preexisting-uuid" }]);

    const out = await applyDecision({
      q: f.q,
      decision: decisionAssign,
      dumpProject: baseDumpProject,
      jobId: "job-1",
    });

    expect(out).toEqual({ status: "already_mapped", localProjectId: "preexisting-uuid" });
    expect(f.calls.some((c) => c.sql.startsWith("insert into clients"))).toBe(false);
    expect(f.calls.some((c) => c.sql.startsWith("insert into projects"))).toBe(false);
  });
});
