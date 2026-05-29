import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryResult = { rows: unknown[]; rowCount?: number };

const queryMock = vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>();
const clientQueryMock = vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>();

vi.mock("@/lib/db", () => ({
  query: queryMock,
  withTransaction: async <T,>(fn: (client: { query: typeof clientQueryMock }) => Promise<T>) => {
    return fn({ query: clientQueryMock });
  }
}));

describe("createProject", () => {
  beforeEach(async () => {
    process.env.DROPBOX_PROJECTS_ROOT_FOLDER = "/projects";
    queryMock.mockReset();
    clientQueryMock.mockReset();
    const { resetProjectsDeadlineCacheForTests } = await import("@/lib/repositories");
    resetProjectsDeadlineCacheForTests();
  });

  it("persists an initial storage_project_dir and inserts creator into project_members atomically", async () => {
    // Pre-TX: getClientById + hasProjectsDeadlineColumn probe
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "client-1", name: "Bright Ridge", code: "BRGS" }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] });

    // Inside TX: project insert, active-user filter, bulk member insert
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: "project-1",
            project_code: "BRGS-0007",
            client_slug: "Bright-Ridge",
            project_slug: "website-refresh",
            storage_project_dir: "/projects/BRGS/BRGS-0007-Website Refresh",
            name: "Website Refresh"
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [] }) // active-user filter — creator's profile isn't in mock; he'll still be inserted
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { createProject } = await import("@/lib/repositories");

    const result = await createProject({
      name: "Website Refresh",
      description: "Revamp the marketing site",
      createdBy: "user-1",
      clientId: "client-1",
      tags: ["Marketing", "Launch"],
      deadline: "2026-04-30",
      requestor: "Jane Producer"
    });

    expect(result.project.id).toBe("project-1");
    expect(result.skippedInactiveUserIds).toEqual([]);
    expect(result.addedMemberEmails).toEqual([]);

    const [insertSql, insertParams] = clientQueryMock.mock.calls[0];
    expect(insertSql).toContain("requestor");
    expect(insertSql).toContain("storage_project_dir");
    expect(insertSql).toContain("deadline");
    expect(insertSql).toContain("where client_id = $4::uuid");
    expect(insertSql).toContain("$4::uuid::text");
    expect(insertSql).toContain("upper(trim($5))");
    expect(insertSql).toContain("regexp_replace");
    expect(insertParams?.[5]).toBe("Bright-Ridge");
    expect(insertParams?.[8]).toBe("/projects");
    expect(insertParams?.[9]).toBe("2026-04-30");
    expect(insertParams?.[10]).toBe("Jane Producer");

    const [memberSql, memberParams] = clientQueryMock.mock.calls[2];
    expect(memberSql).toMatch(/insert into project_members/i);
    expect(memberSql).toMatch(/unnest\(\$2::text\[\]\)/);
    expect(memberParams?.[0]).toBe("project-1");
    expect(memberParams?.[1]).toEqual(["user-1"]);
  });

  it("uses the legacy (no-deadline) SQL when the schema probe returns false", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "client-2", name: "Old Corp", code: "OLDC" }] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] });

    clientQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: "project-99",
            project_code: "OLDC-0001",
            client_slug: "Old-Corp",
            project_slug: "legacy",
            storage_project_dir: "/projects/OLDC/OLDC-0001-Legacy",
            name: "Legacy"
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { createProject } = await import("@/lib/repositories");

    await createProject({
      name: "Legacy",
      description: "Old project",
      createdBy: "user-99",
      clientId: "client-2",
      tags: [],
      deadline: null,
      requestor: null
    });

    const [insertSql] = clientQueryMock.mock.calls[0];
    // Legacy SQL must NOT reference the deadline column
    expect(insertSql).not.toMatch(/\$10::date/);
    expect(insertSql).not.toMatch(/, deadline,/);

    const [memberSql, memberParams] = clientQueryMock.mock.calls[2];
    expect(memberSql).toMatch(/insert into project_members/i);
    expect(memberParams?.[0]).toBe("project-99");
    expect(memberParams?.[1]).toEqual(["user-99"]);
  });

  it("filters memberIds to active users and returns skipped + email lists", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "client-3", name: "Acme", code: "ACME" }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] });

    clientQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: "project-3",
            project_code: "ACME-0003",
            client_slug: "Acme",
            project_slug: "kickoff",
            storage_project_dir: "/projects/ACME/ACME-0003-Kickoff",
            name: "Kickoff"
          }
        ]
      })
      // active-user filter returns only the two valid ids (creator + good1), legacy-id excluded
      .mockResolvedValueOnce({
        rows: [
          { id: "creator-id", email: "creator@example.com" },
          { id: "good-id", email: "good@example.com" }
        ]
      })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] });

    const { createProject } = await import("@/lib/repositories");

    const result = await createProject({
      name: "Kickoff",
      description: "First project",
      createdBy: "creator-id",
      clientId: "client-3",
      tags: [],
      deadline: null,
      requestor: null,
      memberIds: ["good-id", "legacy-id"]
    });

    expect(result.skippedInactiveUserIds).toEqual(["legacy-id"]);
    expect(result.addedMemberEmails).toEqual(["good@example.com"]);

    const [, memberParams] = clientQueryMock.mock.calls[2];
    expect(memberParams?.[0]).toBe("project-3");
    expect(memberParams?.[1]).toEqual(expect.arrayContaining(["creator-id", "good-id"]));
    expect(memberParams?.[1]).not.toContain("legacy-id");
  });
});

describe("bulkInsertProjectMembers", () => {
  it("is a no-op for empty userIds", async () => {
    const fakeClient = { query: vi.fn() };
    const { bulkInsertProjectMembers } = await import("@/lib/repositories");
    await bulkInsertProjectMembers(fakeClient as never, "project-x", []);
    expect(fakeClient.query).not.toHaveBeenCalled();
  });
});

describe("createProject rollback", () => {
  beforeEach(async () => {
    process.env.DROPBOX_PROJECTS_ROOT_FOLDER = "/projects";
    queryMock.mockReset();
    clientQueryMock.mockReset();
    const { resetProjectsDeadlineCacheForTests } = await import("@/lib/repositories");
    resetProjectsDeadlineCacheForTests();
  });

  it("propagates the error when a query inside the transaction throws", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "client-1", name: "Acme", code: "ACME" }] })
      .mockResolvedValueOnce({ rows: [{ exists: true }] });
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [
          { id: "project-1", project_code: "ACME-0001", client_slug: "Acme", project_slug: "p", storage_project_dir: "/x", name: "Roll" }
        ]
      })
      .mockRejectedValueOnce(new Error("simulated FK violation"));

    const { createProject } = await import("@/lib/repositories");
    await expect(
      createProject({
        name: "Roll",
        description: "Rolling back",
        createdBy: "user-1",
        clientId: "client-1",
        tags: [],
        deadline: null,
        requestor: null,
        memberIds: ["legacy"]
      })
    ).rejects.toThrow("simulated FK violation");
  });
});
