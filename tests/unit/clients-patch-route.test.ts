import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const updateClientMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireUser: requireUserMock
}));

vi.mock("@/lib/repositories", () => ({
  updateClient: updateClientMock
}));

describe("PATCH /clients/[id]", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
    updateClientMock.mockReset();
  });

  it("updates client name and returns the row", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    updateClientMock.mockResolvedValue({
      id: "client-uuid",
      name: "Acme Updated",
      code: "ACME",
      github_repos: ["acme/repo"],
      domains: ["acme.test"],
      created_at: "2024-01-01T00:00:00.000Z"
    });

    const { PATCH } = await import("@/app/api/clients/[id]/route");
    const response = await PATCH(
      new Request("http://localhost/clients/client-uuid", {
        method: "PATCH",
        headers: {
          authorization: "Bearer token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: "Acme Updated",
          github_repos: ["acme/repo"],
          domains: ["acme.test"]
        })
      }),
      { params: Promise.resolve({ id: "client-uuid" }) }
    );

    expect(response.status).toBe(200);
    expect(updateClientMock).toHaveBeenCalledWith("client-uuid", {
      name: "Acme Updated",
      githubRepos: ["acme/repo"],
      domains: ["acme.test"]
    });
    await expect(response.json()).resolves.toMatchObject({
      client: {
        name: "Acme Updated",
        code: "ACME",
        github_repos: ["acme/repo"],
        domains: ["acme.test"]
      }
    });
  });

  it("returns 404 when client does not exist", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    updateClientMock.mockResolvedValue(null);

    const { PATCH } = await import("@/app/api/clients/[id]/route");
    const response = await PATCH(
      new Request("http://localhost/clients/missing", {
        method: "PATCH",
        headers: {
          authorization: "Bearer token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "X" })
      }),
      { params: Promise.resolve({ id: "missing" }) }
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 for empty name", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { PATCH } = await import("@/app/api/clients/[id]/route");
    const response = await PATCH(
      new Request("http://localhost/clients/client-uuid", {
        method: "PATCH",
        headers: {
          authorization: "Bearer token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "" })
      }),
      { params: Promise.resolve({ id: "client-uuid" }) }
    );

    expect(response.status).toBe(400);
    expect(updateClientMock).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid github_repos payload", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { PATCH } = await import("@/app/api/clients/[id]/route");
    const response = await PATCH(
      new Request("http://localhost/clients/client-uuid", {
        method: "PATCH",
        headers: {
          authorization: "Bearer token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "Acme Updated", github_repos: [123] })
      }),
      { params: Promise.resolve({ id: "client-uuid" }) }
    );

    expect(response.status).toBe(400);
    expect(updateClientMock).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON payload", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { PATCH } = await import("@/app/api/clients/[id]/route");
    const response = await PATCH(
      new Request("http://localhost/clients/client-uuid", {
        method: "PATCH",
        headers: {
          authorization: "Bearer token",
          "Content-Type": "application/json"
        },
        body: "{"
      }),
      { params: Promise.resolve({ id: "client-uuid" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
    expect(updateClientMock).not.toHaveBeenCalled();
  });

  it("returns 500 with request reference and logs diagnostics for unexpected errors", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    updateClientMock.mockRejectedValue(new Error("db failed"));

    const { PATCH } = await import("@/app/api/clients/[id]/route");
    const response = await PATCH(
      new Request("http://localhost/clients/client-uuid", {
        method: "PATCH",
        headers: {
          authorization: "Bearer token",
          "Content-Type": "application/json",
          "x-request-id": "req-123"
        },
        body: JSON.stringify({ name: "Acme Updated" })
      }),
      { params: Promise.resolve({ id: "client-uuid" }) }
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "Internal server error (ref: req-123)" });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "client_patch_failed",
      expect.objectContaining({
        requestId: "req-123",
        route: "PATCH /clients/:id",
        clientId: "client-uuid",
        actorUserId: "user-1",
        errorName: "Error",
        errorMessage: "db failed"
      })
    );
    consoleErrorSpy.mockRestore();
  });
});
