import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "u1" })
}));

const listClientProjectsMock = vi.fn();
vi.mock("@/lib/repositories", () => ({
  listClientProjects: listClientProjectsMock
}));

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /clients/[id]/projects", () => {
  beforeEach(() => { listClientProjectsMock.mockReset(); });

  it("returns active projects", async () => {
    listClientProjectsMock.mockResolvedValue([{ id: "p1", name: "Web" }]);
    const { GET } = await import("@/app/api/clients/[id]/projects/route");
    const res = await GET(new Request("http://localhost/clients/c1/projects?filter=active"), paramsFor("c1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [{ id: "p1", name: "Web" }] });
    expect(listClientProjectsMock).toHaveBeenCalledWith("c1", "active");
  });

  it("returns archived projects", async () => {
    listClientProjectsMock.mockResolvedValue([]);
    const { GET } = await import("@/app/api/clients/[id]/projects/route");
    const res = await GET(new Request("http://localhost/clients/c1/projects?filter=archived"), paramsFor("c1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [] });
    expect(listClientProjectsMock).toHaveBeenCalledWith("c1", "archived");
  });

  it("400s on invalid filter", async () => {
    const { GET } = await import("@/app/api/clients/[id]/projects/route");
    const res = await GET(new Request("http://localhost/clients/c1/projects?filter=junk"), paramsFor("c1"));
    expect(res.status).toBe(400);
    expect(listClientProjectsMock).not.toHaveBeenCalled();
  });

  it("400s when filter missing", async () => {
    const { GET } = await import("@/app/api/clients/[id]/projects/route");
    const res = await GET(new Request("http://localhost/clients/c1/projects"), paramsFor("c1"));
    expect(res.status).toBe(400);
  });
});
