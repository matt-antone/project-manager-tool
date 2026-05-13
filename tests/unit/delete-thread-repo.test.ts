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
