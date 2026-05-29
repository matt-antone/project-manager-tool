import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const touchProjectActivityMock = vi.fn();

vi.mock("@/lib/db", () => ({ query: queryMock }));

beforeEach(() => {
  vi.resetModules();
  queryMock.mockReset();
  touchProjectActivityMock.mockReset();
});

describe("countNonAuthorComments", () => {
  it("counts comments authored by users other than the thread author", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ c: 3 }] });
    const { countNonAuthorComments } = await import("@/lib/repositories");
    const n = await countNonAuthorComments({ projectId: "p1", threadId: "t1", authorUserId: "u1" });
    expect(n).toBe(3);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/from discussion_comments/);
    expect(sql).toMatch(/author_user_id <> \$3/);
    expect(params).toEqual(["p1", "t1", "u1"]);
  });

  it("returns 0 when no rows match", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ c: 0 }] });
    const { countNonAuthorComments } = await import("@/lib/repositories");
    const n = await countNonAuthorComments({ projectId: "p1", threadId: "t1", authorUserId: "u1" });
    expect(n).toBe(0);
  });
});

describe("deleteThread", () => {
  it("issues a delete scoped to project + thread id and touches activity", async () => {
    // First call: the DELETE. Second call: touchProjectActivity's internal query.
    queryMock.mockResolvedValue({ rows: [] });
    const { deleteThread } = await import("@/lib/repositories");
    await deleteThread({ projectId: "p1", threadId: "t1" });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/delete from discussion_threads/);
    expect(sql).toMatch(/where id = \$1 and project_id = \$2/);
    expect(params).toEqual(["t1", "p1"]);
    // Activity touch invoked at least once after the delete.
    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
