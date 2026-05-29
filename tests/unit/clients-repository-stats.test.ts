import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("@/lib/db", () => ({
  query: queryMock
}));

describe("listClientsWithStats", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("filters by active and returns rows with active project count and last activity", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "c1",
          name: "Acme",
          code: "ACME",
          github_repos: [],
          domains: [],
          created_at: "2026-01-01T00:00:00.000Z",
          archived_at: null,
          active_project_count: "3",
          last_activity_at: "2026-05-10T12:00:00.000Z"
        }
      ]
    });

    const { listClientsWithStats } = await import("@/lib/repositories");
    const rows = await listClientsWithStats("active");

    expect(rows).toEqual([
      expect.objectContaining({
        id: "c1",
        active_project_count: 3,
        last_activity_at: "2026-05-10T12:00:00.000Z"
      })
    ]);

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/where c\.archived_at is null/i);
    expect(sql).toMatch(/count\(p\.id\) filter \(where p\.archived = false\)/i);
    expect(sql).toMatch(/max\(p\.last_activity_at\) filter \(where p\.archived = false\)/i);
  });

  it("filters by archived using 'is not null'", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { listClientsWithStats } = await import("@/lib/repositories");
    await listClientsWithStats("archived");
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/where c\.archived_at is not null/i);
  });

  it("normalizes string counts to numbers", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: "c2", name: "B", code: "B", github_repos: [], domains: [],
        created_at: "2026-01-01T00:00:00.000Z", archived_at: null,
        active_project_count: "0", last_activity_at: null
      }]
    });
    const { listClientsWithStats } = await import("@/lib/repositories");
    const rows = await listClientsWithStats("active");
    expect(rows[0].active_project_count).toBe(0);
    expect(rows[0].last_activity_at).toBeNull();
  });
});

describe("getClientTabCounts", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("returns active and archived client counts as numbers", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ active: "12", archived: "5" }]
    });
    const { getClientTabCounts } = await import("@/lib/repositories");
    const counts = await getClientTabCounts();
    expect(counts).toEqual({ active: 12, archived: 5 });
  });

  it("returns zero counts when no clients", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ active: "0", archived: "0" }]
    });
    const { getClientTabCounts } = await import("@/lib/repositories");
    expect(await getClientTabCounts()).toEqual({ active: 0, archived: 0 });
  });
});

describe("getClientWithStats", () => {
  beforeEach(() => { queryMock.mockReset(); });

  it("returns null when client missing", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { getClientWithStats } = await import("@/lib/repositories");
    expect(await getClientWithStats("missing")).toBeNull();
  });

  it("returns client row plus computed stats", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: "c1", name: "Acme", code: "ACME", github_repos: ["acme/web"], domains: ["acme.com"],
        created_at: "2026-01-01T00:00:00.000Z", archived_at: null,
        active_project_count: "7",
        archived_project_count: "3",
        last_activity_at: "2026-05-10T12:00:00.000Z"
      }]
    });
    const { getClientWithStats } = await import("@/lib/repositories");
    const result = await getClientWithStats("c1");
    expect(result).toEqual({
      client: expect.objectContaining({ id: "c1", github_repos: ["acme/web"], domains: ["acme.com"] }),
      stats: { activeProjectCount: 7, archivedProjectCount: 3, lastActivityAt: "2026-05-10T12:00:00.000Z" }
    });
  });
});

describe("listClientProjects", () => {
  beforeEach(() => { queryMock.mockReset(); });

  it("filters active projects", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: "p1", name: "Web", status: "in_progress",
        last_activity_at: "2026-05-10T00:00:00.000Z",
        deadline: "2026-06-01", created_at: "2026-03-14T00:00:00.000Z"
      }]
    });
    const { listClientProjects } = await import("@/lib/repositories");
    const rows = await listClientProjects("c1", "active");
    expect(rows).toEqual([
      {
        id: "p1", name: "Web", status: "in_progress",
        last_activity_at: "2026-05-10T00:00:00.000Z",
        deadline: "2026-06-01", created_at: "2026-03-14T00:00:00.000Z"
      }
    ]);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/where client_id = \$1\s+and archived = \$2/i);
    expect(params).toEqual(["c1", false]);
  });

  it("filters archived projects", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { listClientProjects } = await import("@/lib/repositories");
    await listClientProjects("c1", "archived");
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(["c1", true]);
  });
});
