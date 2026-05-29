import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "u1" })
}));

const listClientsMock = vi.fn();
const listClientsWithStatsMock = vi.fn();
const getClientTabCountsMock = vi.fn();
const createClientMock = vi.fn();

vi.mock("@/lib/repositories", () => ({
  listClients: listClientsMock,
  listClientsWithStats: listClientsWithStatsMock,
  getClientTabCounts: getClientTabCountsMock,
  createClient: createClientMock
}));

describe("GET /clients with ?stats=1", () => {
  beforeEach(() => {
    listClientsMock.mockReset();
    listClientsWithStatsMock.mockReset();
    getClientTabCountsMock.mockReset();
  });

  it("returns plain client list without stats=1 (existing behavior)", async () => {
    listClientsMock.mockResolvedValue([{ id: "c1", name: "Acme" }]);
    const { GET } = await import("@/app/api/clients/route");
    const res = await GET(new Request("http://localhost/clients"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ clients: [{ id: "c1", name: "Acme" }] });
    expect(listClientsWithStatsMock).not.toHaveBeenCalled();
  });

  it("returns both filtered lists + counts when stats=1", async () => {
    listClientsWithStatsMock
      .mockResolvedValueOnce([{ id: "c1", active_project_count: 3, last_activity_at: null }])
      .mockResolvedValueOnce([{ id: "c2", active_project_count: 0, last_activity_at: null }]);
    getClientTabCountsMock.mockResolvedValue({ active: 1, archived: 1 });

    const { GET } = await import("@/app/api/clients/route");
    const res = await GET(new Request("http://localhost/clients?stats=1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.counts).toEqual({ active: 1, archived: 1 });
    expect(body.active).toEqual([{ id: "c1", active_project_count: 3, last_activity_at: null }]);
    expect(body.archived).toEqual([{ id: "c2", active_project_count: 0, last_activity_at: null }]);
    expect(listClientsWithStatsMock).toHaveBeenNthCalledWith(1, "active");
    expect(listClientsWithStatsMock).toHaveBeenNthCalledWith(2, "archived");
  });
});
