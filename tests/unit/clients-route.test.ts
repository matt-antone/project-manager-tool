import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const createClientMock = vi.fn();
const listClientsMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireUser: requireUserMock
}));

vi.mock("@/lib/repositories", () => ({
  createClient: createClientMock,
  listClients: listClientsMock
}));

describe("POST /clients", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
    createClientMock.mockReset();
    listClientsMock.mockReset();
  });

  it("creates a client with github_repos and domains", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    createClientMock.mockResolvedValue({
      id: "client-uuid",
      name: "Acme",
      code: "ACME",
      github_repos: ["acme/repo"],
      domains: ["acme.test"],
      created_at: "2024-01-01T00:00:00.000Z"
    });

    const { POST } = await import("@/app/api/clients/route");
    const response = await POST(
      new Request("http://localhost/clients", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: "Acme",
          code: "ACME",
          github_repos: ["acme/repo"],
          domains: ["acme.test"]
        })
      })
    );

    expect(response.status).toBe(201);
    expect(createClientMock).toHaveBeenCalledWith({
      name: "Acme",
      code: "ACME",
      githubRepos: ["acme/repo"],
      domains: ["acme.test"]
    });
    await expect(response.json()).resolves.toMatchObject({
      client: {
        name: "Acme",
        code: "ACME",
        github_repos: ["acme/repo"],
        domains: ["acme.test"]
      }
    });
  });

  it("accepts omitted github_repos/domains and defaults to empty arrays", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    createClientMock.mockResolvedValue({
      id: "client-uuid",
      name: "Acme",
      code: "ACME",
      github_repos: [],
      domains: [],
      created_at: "2024-01-01T00:00:00.000Z"
    });

    const { POST } = await import("@/app/api/clients/route");
    const response = await POST(
      new Request("http://localhost/clients", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "Acme", code: "ACME" })
      })
    );

    expect(response.status).toBe(201);
    expect(createClientMock).toHaveBeenCalledWith({
      name: "Acme",
      code: "ACME",
      githubRepos: [],
      domains: []
    });
  });

  it("returns 400 for invalid domains payload", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });

    const { POST } = await import("@/app/api/clients/route");
    const response = await POST(
      new Request("http://localhost/clients", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "Acme", code: "ACME", domains: [42] })
      })
    );

    expect(response.status).toBe(400);
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
