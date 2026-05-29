import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "u1" })
}));

const getClientByIdMock = vi.fn();
const getClientWithStatsMock = vi.fn();
const updateClientMock = vi.fn();

vi.mock("@/lib/repositories", () => ({
  getClientById: getClientByIdMock,
  getClientWithStats: getClientWithStatsMock,
  updateClient: updateClientMock
}));

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /clients/[id] with ?stats=1", () => {
  beforeEach(() => {
    getClientByIdMock.mockReset();
    getClientWithStatsMock.mockReset();
  });

  it("returns plain client without stats=1", async () => {
    getClientByIdMock.mockResolvedValue({ id: "c1", name: "Acme" });
    const { GET } = await import("@/app/api/clients/[id]/route");
    const res = await GET(new Request("http://localhost/clients/c1"), paramsFor("c1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ client: { id: "c1", name: "Acme" } });
    expect(getClientWithStatsMock).not.toHaveBeenCalled();
  });

  it("returns 404 when stats=1 client missing", async () => {
    getClientWithStatsMock.mockResolvedValue(null);
    const { GET } = await import("@/app/api/clients/[id]/route");
    const res = await GET(new Request("http://localhost/clients/c1?stats=1"), paramsFor("c1"));
    expect(res.status).toBe(404);
  });

  it("returns client + stats when stats=1", async () => {
    getClientWithStatsMock.mockResolvedValue({
      client: { id: "c1", name: "Acme" },
      stats: { activeProjectCount: 7, archivedProjectCount: 3, lastActivityAt: "2026-05-10T12:00:00.000Z" }
    });
    const { GET } = await import("@/app/api/clients/[id]/route");
    const res = await GET(new Request("http://localhost/clients/c1?stats=1"), paramsFor("c1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      client: { id: "c1", name: "Acme" },
      stats: { activeProjectCount: 7, archivedProjectCount: 3, lastActivityAt: "2026-05-10T12:00:00.000Z" }
    });
  });
});
