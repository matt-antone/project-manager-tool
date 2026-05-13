import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const getProjectMock = vi.fn();
const getThreadMock = vi.fn();
const countNonAuthorCommentsMock = vi.fn();
const deleteThreadMock = vi.fn();

vi.mock("@/lib/auth", () => ({ requireUser: requireUserMock }));
vi.mock("@/lib/repositories", () => ({
  getProject: getProjectMock,
  getThread: getThreadMock,
  editThread: vi.fn(),
  countNonAuthorComments: countNonAuthorCommentsMock,
  deleteThread: deleteThreadMock
}));

beforeEach(() => {
  vi.resetModules();
  [requireUserMock, getProjectMock, getThreadMock, countNonAuthorCommentsMock, deleteThreadMock].forEach((m) => m.mockReset());
});

function req() {
  return new Request("http://localhost/projects/p1/threads/t1", { method: "DELETE" });
}
const params = { params: Promise.resolve({ id: "p1", threadId: "t1" }) };

describe("DELETE /projects/[id]/threads/[threadId]", () => {
  it("returns 200 and deletes when author and no third-party comments", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    getProjectMock.mockResolvedValue({ id: "p1" });
    getThreadMock.mockResolvedValue({ id: "t1", author_user_id: "u1" });
    countNonAuthorCommentsMock.mockResolvedValue(0);
    deleteThreadMock.mockResolvedValue(undefined);
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(200);
    expect(deleteThreadMock).toHaveBeenCalledWith({ projectId: "p1", threadId: "t1" });
  });

  it("returns 403 when caller is not the author", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    getProjectMock.mockResolvedValue({ id: "p1" });
    getThreadMock.mockResolvedValue({ id: "t1", author_user_id: "someone-else" });
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(403);
    expect(deleteThreadMock).not.toHaveBeenCalled();
  });

  it("returns 403 when other users have commented", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    getProjectMock.mockResolvedValue({ id: "p1" });
    getThreadMock.mockResolvedValue({ id: "t1", author_user_id: "u1" });
    countNonAuthorCommentsMock.mockResolvedValue(2);
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(403);
    expect(deleteThreadMock).not.toHaveBeenCalled();
  });

  it("returns 404 when project missing", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    getProjectMock.mockResolvedValue(null);
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(404);
  });

  it("returns 404 when thread missing", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    getProjectMock.mockResolvedValue({ id: "p1" });
    getThreadMock.mockResolvedValue(null);
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(404);
  });

  it("returns 401 when auth fails", async () => {
    requireUserMock.mockRejectedValue(new Error("auth required"));
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(401);
  });
});
