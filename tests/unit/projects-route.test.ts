import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const createProjectMock = vi.fn();
const listProjectsMock = vi.fn();
const deleteProjectByIdMock = vi.fn();
const setProjectStorageDirMock = vi.fn();
const assertClientNotArchivedForMutationMock = vi.fn();
const ensureProjectFoldersMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireUser: requireUserMock
}));

vi.mock("@/lib/repositories", () => ({
  assertClientNotArchivedForMutation: assertClientNotArchivedForMutationMock,
  createProject: createProjectMock,
  listProjects: listProjectsMock,
  deleteProjectById: deleteProjectByIdMock,
  setProjectStorageDir: setProjectStorageDirMock
}));

vi.mock("@/lib/storage/dropbox-adapter", () => ({
  DropboxStorageAdapter: vi.fn(() => ({
    ensureProjectFolders: ensureProjectFoldersMock
  })),
  getDropboxErrorSummary: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
  isTeamSelectUserRequiredError: vi.fn(() => false)
}));

describe("POST /projects", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
    createProjectMock.mockReset();
    listProjectsMock.mockReset();
    deleteProjectByIdMock.mockReset();
    setProjectStorageDirMock.mockReset();
    assertClientNotArchivedForMutationMock.mockReset();
    ensureProjectFoldersMock.mockReset();
  });

  it("rolls back and returns a clear error when Dropbox provisioning fails", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    createProjectMock.mockResolvedValue({
      project: {
        id: "project-1",
        name: "Website Refresh",
        project_code: "BRGS-0001",
        project_slug: "website-refresh",
        client_slug: "Bright-Ridge",
        storage_project_dir: "/Projects/BRGS/BRGS-0001-Website Refresh"
      },
      skippedInactiveUserIds: [],
      addedMemberEmails: []
    });
    ensureProjectFoldersMock.mockRejectedValue(new Error("Dropbox offline"));
    deleteProjectByIdMock.mockResolvedValue(undefined);

    const { POST } = await import("@/app/projects/route");
    const response = await POST(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "Website Refresh",
          clientId: "11111111-1111-1111-8111-111111111111"
        })
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "Project creation failed while provisioning Dropbox folders: Dropbox offline"
    });
    expect(deleteProjectByIdMock).toHaveBeenCalledWith("project-1");
    expect(setProjectStorageDirMock).not.toHaveBeenCalled();
  });

  it("passes requestor through when creating a project", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    createProjectMock.mockResolvedValue({
      project: {
        id: "project-1",
        name: "Website Refresh",
        project_code: "BRGS-0001",
        project_slug: "website-refresh",
        client_slug: "Bright-Ridge",
        storage_project_dir: "/Projects/BRGS/BRGS-0001-Website Refresh"
      },
      skippedInactiveUserIds: [],
      addedMemberEmails: []
    });
    ensureProjectFoldersMock.mockResolvedValue({
      projectDir: "/Projects/BRGS/BRGS-0001-Website Refresh"
    });
    setProjectStorageDirMock.mockResolvedValue({
      id: "project-1",
      requestor: "Jane Producer"
    });

    const { POST } = await import("@/app/projects/route");
    const response = await POST(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "Website Refresh",
          clientId: "11111111-1111-1111-8111-111111111111",
          deadline: "2026-05-30",
          requestor: "Jane Producer"
        })
      })
    );

    expect(response.status).toBe(201);
    expect(ensureProjectFoldersMock).toHaveBeenCalledWith({
      clientCodeUpper: "BRGS",
      projectFolderBaseName: "BRGS-0001-Website Refresh"
    });
    expect(createProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deadline: "2026-05-30",
        requestor: "Jane Producer"
      })
    );
  });

  it("returns 409 when the selected client is archived", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    assertClientNotArchivedForMutationMock.mockRejectedValue(
      new Error("Client is archived. Restore it before creating new work.")
    );

    const { POST } = await import("@/app/projects/route");
    const response = await POST(
      new Request("http://localhost/projects", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "Website Refresh",
          clientId: "11111111-1111-1111-8111-111111111111"
        })
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Client is archived. Restore it before creating new work."
    });
    expect(assertClientNotArchivedForMutationMock).toHaveBeenCalledWith(
      "11111111-1111-1111-8111-111111111111",
      expect.objectContaining({
        archived: "Client is archived. Restore it before creating new work."
      })
    );
    expect(createProjectMock).not.toHaveBeenCalled();
  });
});

describe("GET /projects", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    listProjectsMock.mockReset();
  });

  it("returns 401 when auth fails", async () => {
    requireUserMock.mockRejectedValue(new Error("auth missing"));

    const { GET } = await import("@/app/projects/route");
    const response = await GET(new Request("http://localhost/projects"));

    expect(response.status).toBe(401);
    expect(listProjectsMock).not.toHaveBeenCalled();
  });

  it("parses clientId and search and calls listProjects with expected options", async () => {
    listProjectsMock.mockResolvedValue([{ id: "p1", name: "Alpha" }]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(
      new Request(
        "http://localhost/projects?clientId=11111111-1111-1111-8111-111111111111&search=website%20refresh"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projects: [{ id: "p1", name: "Alpha" }]
    });
    expect(listProjectsMock).toHaveBeenCalledWith(true, {
      clientId: "11111111-1111-1111-8111-111111111111",
      search: "website refresh"
    });
  });

  it("returns 400 when clientId is present but not a valid UUID", async () => {
    const { GET } = await import("@/app/projects/route");
    const response = await GET(new Request("http://localhost/projects?clientId=not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid clientId"
    });
    expect(listProjectsMock).not.toHaveBeenCalled();
  });

  it("parses billingOnly=true and passes billingOnly to listProjects", async () => {
    listProjectsMock.mockResolvedValue([]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(new Request("http://localhost/projects?billingOnly=true"));

    expect(response.status).toBe(200);
    expect(listProjectsMock).toHaveBeenCalledWith(true, { clientId: null, search: "", billingOnly: true });
  });

  it("passes includeArchived=false alongside the billing filter", async () => {
    listProjectsMock.mockResolvedValue([]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(new Request("http://localhost/projects?billingOnly=true&includeArchived=false"));

    expect(response.status).toBe(200);
    expect(listProjectsMock).toHaveBeenCalledWith(false, { clientId: null, search: "", billingOnly: true });
  });

  it("parses sort=title and passes sort to listProjects when search is empty", async () => {
    listProjectsMock.mockResolvedValue([]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(new Request("http://localhost/projects?sort=title"));

    expect(response.status).toBe(200);
    expect(listProjectsMock).toHaveBeenCalledWith(true, { clientId: null, search: "", sort: "title" });
  });

  it("parses sort=deadline and passes sort to listProjects when search is empty", async () => {
    listProjectsMock.mockResolvedValue([]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(new Request("http://localhost/projects?sort=deadline"));

    expect(response.status).toBe(200);
    expect(listProjectsMock).toHaveBeenCalledWith(true, { clientId: null, search: "", sort: "deadline" });
  });

  it("does not pass sort to listProjects when search is active (FTS ignores sort)", async () => {
    listProjectsMock.mockResolvedValue([{ id: "p1", name: "Alpha" }]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(
      new Request("http://localhost/projects?search=foo&sort=title")
    );

    expect(response.status).toBe(200);
    expect(listProjectsMock).toHaveBeenCalledWith(true, {
      clientId: null,
      search: "foo"
    });
  });

  it("returns 400 when sort is not title or deadline", async () => {
    const { GET } = await import("@/app/projects/route");
    const response = await GET(new Request("http://localhost/projects?sort=created_at"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid sort"
    });
    expect(listProjectsMock).not.toHaveBeenCalled();
  });
});
