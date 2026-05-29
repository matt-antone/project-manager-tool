import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const listProjectsMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireUser: requireUserMock
}));

vi.mock("@/lib/repositories", () => ({
  listProjects: listProjectsMock
}));

function makeBreakdownRow(overrides: {
  userId?: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string;
  avatarUrl?: string | null;
  hours?: number | string;
} = {}) {
  return {
    userId: overrides.userId ?? "user-1",
    firstName: overrides.firstName ?? "Pat",
    lastName: overrides.lastName ?? "Example",
    email: overrides.email ?? "pat@example.com",
    avatarUrl: overrides.avatarUrl ?? null,
    hours: overrides.hours ?? 4.5
  };
}

function makeBillingProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    name: "Alpha",
    display_name: "ACME-2026 Alpha",
    description: null,
    status: "billing",
    archived: false,
    client_id: "client-1",
    client_name: "Acme",
    client_code: "ACME",
    project_code: "ACME-001",
    total_hours: "10.00",
    discussion_count: 0,
    file_count: 0,
    user_hours_breakdown: [],
    ...overrides
  };
}

describe("GET /projects?billingOnly=true — user_hours_breakdown shape", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
    listProjectsMock.mockReset();
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    vi.resetModules();
  });

  it("returns rows with user_hours_breakdown array when billingOnly=true", async () => {
    const breakdown = [
      makeBreakdownRow({ userId: "u-1", firstName: "Alice", lastName: "Smith", email: "alice@example.com", hours: 6 }),
      makeBreakdownRow({ userId: "u-2", firstName: "Bob", lastName: "Jones", email: "bob@example.com", hours: 4 })
    ];
    listProjectsMock.mockResolvedValue([
      makeBillingProject({ user_hours_breakdown: breakdown, total_hours: "10.00" })
    ]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(
      new Request("http://localhost/projects?billingOnly=true&includeArchived=false")
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { projects: unknown[] };
    expect(body.projects).toHaveLength(1);
    const project = body.projects[0] as { user_hours_breakdown: unknown[] };
    expect(Array.isArray(project.user_hours_breakdown)).toBe(true);
    expect(project.user_hours_breakdown).toHaveLength(2);
  });

  it("passes billingOnly:true to listProjects when billingOnly=true query param present", async () => {
    listProjectsMock.mockResolvedValue([makeBillingProject()]);

    const { GET } = await import("@/app/projects/route");
    await GET(new Request("http://localhost/projects?billingOnly=true&includeArchived=false"));

    expect(listProjectsMock).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ billingOnly: true })
    );
  });

  it("does not pass billingOnly when param is absent", async () => {
    listProjectsMock.mockResolvedValue([]);

    const { GET } = await import("@/app/projects/route");
    await GET(new Request("http://localhost/projects?includeArchived=false"));

    expect(listProjectsMock).toHaveBeenCalledWith(
      false,
      expect.not.objectContaining({ billingOnly: true })
    );
  });

  it("returns user_hours_breakdown:[] for a project with no hours rows", async () => {
    listProjectsMock.mockResolvedValue([
      makeBillingProject({ user_hours_breakdown: [], total_hours: "0.00" })
    ]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(
      new Request("http://localhost/projects?billingOnly=true&includeArchived=false")
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { projects: Array<{ user_hours_breakdown: unknown[] }> };
    expect(body.projects[0].user_hours_breakdown).toEqual([]);
  });

  it("each breakdown entry has userId, firstName, lastName, email, avatarUrl, hours", async () => {
    const row = makeBreakdownRow({
      userId: "u-abc",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      avatarUrl: "https://example.com/avatar.png",
      hours: 7.75
    });
    listProjectsMock.mockResolvedValue([
      makeBillingProject({ user_hours_breakdown: [row] })
    ]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(
      new Request("http://localhost/projects?billingOnly=true&includeArchived=false")
    );

    const body = await response.json() as {
      projects: Array<{ user_hours_breakdown: Array<Record<string, unknown>> }>
    };
    const entry = body.projects[0].user_hours_breakdown[0];
    expect(entry).toMatchObject({
      userId: "u-abc",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      avatarUrl: "https://example.com/avatar.png",
      hours: 7.75
    });
  });

  it("returns 200 with user_hours_breakdown:[] on all rows when missing-table error occurs (fallback)", async () => {
    // Simulate isMissingProjectUserHoursTableError being caught inside listProjects;
    // the repo already handles it and returns rows with []. Here we test that the
    // route itself does not re-throw and returns 200 with empty breakdowns.
    listProjectsMock.mockResolvedValue([
      makeBillingProject({ user_hours_breakdown: [] }),
      makeBillingProject({ id: "project-2", name: "Beta", user_hours_breakdown: [] })
    ]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(
      new Request("http://localhost/projects?billingOnly=true&includeArchived=false")
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      projects: Array<{ user_hours_breakdown: unknown[] }>
    };
    expect(body.projects).toHaveLength(2);
    body.projects.forEach((p) => {
      expect(p.user_hours_breakdown).toEqual([]);
    });
  });

  it("returns 401 when auth fails", async () => {
    requireUserMock.mockRejectedValue(new Error("auth required"));

    const { GET } = await import("@/app/projects/route");
    const response = await GET(
      new Request("http://localhost/projects?billingOnly=true&includeArchived=false")
    );

    expect(response.status).toBe(401);
    expect(listProjectsMock).not.toHaveBeenCalled();
  });

  it("sum invariant: sum of breakdown hours equals total_hours for uncapped sets", async () => {
    const breakdown = [
      makeBreakdownRow({ userId: "u-1", hours: 3 }),
      makeBreakdownRow({ userId: "u-2", hours: 5.5 }),
      makeBreakdownRow({ userId: "u-3", hours: 1.5 })
    ];
    const totalHours = breakdown.reduce((acc, r) => acc + Number(r.hours), 0).toFixed(2);
    listProjectsMock.mockResolvedValue([
      makeBillingProject({ user_hours_breakdown: breakdown, total_hours: totalHours })
    ]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(
      new Request("http://localhost/projects?billingOnly=true&includeArchived=false")
    );

    const body = await response.json() as {
      projects: Array<{ user_hours_breakdown: Array<{ hours: number }>; total_hours: string }>
    };
    const project = body.projects[0];
    const sum = project.user_hours_breakdown.reduce((acc, r) => acc + Number(r.hours), 0);
    expect(sum.toFixed(2)).toBe(project.total_hours);
  });

  it("LIMIT cap: breakdown with 200 entries is returned intact (capped payload)", async () => {
    const breakdown = Array.from({ length: 200 }, (_, i) =>
      makeBreakdownRow({
        userId: `u-${i}`,
        firstName: "User",
        lastName: String(i).padStart(3, "0"),
        email: `user${i}@example.com`,
        hours: 1
      })
    );
    listProjectsMock.mockResolvedValue([
      makeBillingProject({ user_hours_breakdown: breakdown, total_hours: "200.00" })
    ]);

    const { GET } = await import("@/app/projects/route");
    const response = await GET(
      new Request("http://localhost/projects?billingOnly=true&includeArchived=false")
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      projects: Array<{ user_hours_breakdown: unknown[]; total_hours: string }>
    };
    expect(body.projects[0].user_hours_breakdown).toHaveLength(200);
    expect(body.projects[0].total_hours).toBe("200.00");
  });
});
