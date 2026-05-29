import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectUserHours } from "@/lib/repositories";

vi.mock("@/lib/browser-auth", () => ({
  authedJsonFetch: vi.fn(() => new Promise(() => {}))
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    React.createElement("a", { href, className }, children)
}));

vi.mock("@/components/one-shot-button", () => ({
  OneShotButton: ({ children, className, type }: { children: React.ReactNode; className?: string; type?: string }) =>
    React.createElement("button", { className, type }, children)
}));

vi.mock("@/components/project-tag-list", () => ({
  ProjectTagList: ({ tags }: { tags: string[] }) =>
    React.createElement("ul", {}, ...tags.map((t) => React.createElement("li", { key: t }, t)))
}));

function makeRow(overrides: Partial<ProjectUserHours> = {}): ProjectUserHours {
  return {
    userId: overrides.userId ?? "u-1",
    firstName: overrides.firstName ?? "Alice",
    lastName: overrides.lastName ?? "Smith",
    email: overrides.email ?? "alice@example.com",
    avatarUrl: overrides.avatarUrl ?? null,
    hours: overrides.hours ?? 3
  };
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    name: "Alpha Project",
    display_name: "ACME-2026 Alpha",
    description: null,
    tags: null,
    status: "billing",
    client_name: "Acme Corp",
    client_code: "ACME",
    total_hours: "10.00",
    ...overrides
  };
}

async function renderRow(project: ReturnType<typeof makeProject>) {
  const { BillingProjectRow } = await import("@/components/projects/billing-project-row");
  return renderToStaticMarkup(
    React.createElement(BillingProjectRow, {
      project,
      onArchive: () => {},
      onReopen: () => {}
    })
  );
}

describe("BillingProjectRow", () => {
  it("renders project title and client label", async () => {
    const markup = await renderRow(makeProject());
    expect(markup).toContain("ACME-2026 Alpha");
    expect(markup).toContain("Acme Corp");
  });

  it("renders Archive and Reopen work buttons", async () => {
    const markup = await renderRow(makeProject());
    expect(markup).toContain(">Archive<");
    expect(markup).toContain(">Reopen work<");
  });

  it("does not render hours table when user_hours_breakdown is empty", async () => {
    const markup = await renderRow(makeProject({ user_hours_breakdown: [] }));
    expect(markup).not.toContain("aria-label=\"User hours breakdown\"");
    expect(markup).not.toContain(">Total<");
  });

  it("does not render hours table when user_hours_breakdown is absent", async () => {
    const markup = await renderRow(makeProject());
    expect(markup).not.toContain("class=\"archiveProjectHours\"");
    expect(markup).not.toContain("archiveProjectRow--withBreakdown");
  });

  it("renders 2-col layout with table when breakdown has rows", async () => {
    const breakdown = [makeRow()];
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown, total_hours: "3.00" }));
    expect(markup).toContain("aria-label=\"Hours breakdown for");
    expect(markup).toContain("archiveProjectRow--withBreakdown");
    expect(markup).toContain("class=\"archiveProjectHours\"");
  });

  it("renders Name and Hours column headers", async () => {
    const breakdown = [makeRow()];
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown }));
    expect(markup).toContain(">Name<");
    expect(markup).toContain(">Hours<");
  });

  it("renders display name as 'firstName lastName' when both present", async () => {
    const breakdown = [makeRow({ firstName: "Jane", lastName: "Doe", email: "jane@example.com" })];
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown }));
    expect(markup).toContain(">Jane Doe<");
    expect(markup).not.toContain(">jane@example.com<");
  });

  it("falls back to email when firstName and lastName are both null", async () => {
    const breakdown: ProjectUserHours[] = [{
      userId: "u-null",
      firstName: null,
      lastName: null,
      email: "noid@example.com",
      avatarUrl: null,
      hours: 2
    }];
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown }));
    expect(markup).toContain(">noid@example.com<");
  });

  it("falls back to email when firstName and lastName are empty strings", async () => {
    const breakdown: ProjectUserHours[] = [{
      userId: "u-empty",
      firstName: "",
      lastName: "",
      email: "empty@example.com",
      avatarUrl: null,
      hours: 2
    }];
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown }));
    expect(markup).toContain(">empty@example.com<");
  });

  it("sorts display: rows appear in lastName ASC order (as supplied by server)", async () => {
    const breakdown = [
      makeRow({ userId: "u-z", firstName: "Zara", lastName: "zebra", email: "z@example.com", hours: 1 }),
      makeRow({ userId: "u-a", firstName: "Alice", lastName: "apple", email: "a@example.com", hours: 2 })
    ];
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown }));
    const zebraIdx = markup.indexOf(">Zara zebra<");
    const appleIdx = markup.indexOf(">Alice apple<");
    expect(zebraIdx).toBeGreaterThan(-1);
    expect(appleIdx).toBeGreaterThan(-1);
    // Component renders in the order supplied by server; apple came second in our array
    // so zebra (index 0) should appear before apple (index 1) in the markup
    expect(zebraIdx).toBeLessThan(appleIdx);
  });

  it("renders hours formatted to 2 decimal places per row", async () => {
    const breakdown = [makeRow({ hours: 4.5 })];
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown }));
    expect(markup).toContain(">4.50<");
  });

  it("renders Total row with formatted total_hours from project", async () => {
    const breakdown = [makeRow({ hours: 7.25 })];
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown, total_hours: "7.25" }));
    expect(markup).toContain(">Total<");
    expect(markup).toContain(">7.25<");
  });

  it("Total row uses project.total_hours, not sum of breakdown", async () => {
    const breakdown = [
      makeRow({ userId: "u-1", hours: 3 }),
      makeRow({ userId: "u-2", hours: 3 })
    ];
    // total_hours is authoritative from server
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown, total_hours: "99.99" }));
    expect(markup).toContain(">99.99<");
  });

  it("does not render a toggle button or aria-expanded", async () => {
    const breakdown = [makeRow()];
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown }));
    expect(markup).not.toContain("aria-expanded");
  });

  it("renders Missing hours badge when hasMissingHours is true", async () => {
    // hasMissingHours returns true when total_hours is null/0 and no my_hours
    const breakdown = [makeRow()];
    const markup = await renderRow(
      makeProject({ user_hours_breakdown: breakdown, total_hours: null, my_hours: null })
    );
    expect(markup).toContain(">Missing hours<");
  });

  it("renders exactly 200 body rows plus Total row when breakdown has 200 entries", async () => {
    const breakdown = Array.from({ length: 200 }, (_, i) =>
      makeRow({ userId: `u-${i}`, firstName: "User", lastName: `${i}`, email: `u${i}@example.com`, hours: 1 })
    );
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown, total_hours: "200.00" }));
    // 1 thead <tr> + 200 tbody <tr> + 1 tfoot <tr> = 202 total <tr> tags
    const allTrCount = (markup.match(/<tr[\s>]/g) ?? []).length;
    expect(allTrCount).toBe(202);
    // Count tbody data rows by looking at name cells (excludes Total in tfoot which has additional class)
    const bodyRowCount = (markup.match(/<td class="archiveProjectHoursName">/g) ?? []).length;
    expect(bodyRowCount).toBe(200);
    // Total cell present with extra class
    expect(markup).toContain("archiveProjectHoursName archiveProjectHoursTotal");
  });

  it("renders footer note '200' when breakdown.length === 200", async () => {
    const breakdown = Array.from({ length: 200 }, (_, i) =>
      makeRow({ userId: `u-${i}`, email: `u${i}@example.com`, hours: 1 })
    );
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown, total_hours: "200.00" }));
    expect(markup).toContain("200");
    // Footer note paragraph should be present
    expect(markup).toContain("Showing first 200");
  });

  it("does not render footer note when breakdown.length < 200", async () => {
    const breakdown = Array.from({ length: 5 }, (_, i) =>
      makeRow({ userId: `u-${i}`, email: `u${i}@example.com`, hours: 1 })
    );
    const markup = await renderRow(makeProject({ user_hours_breakdown: breakdown, total_hours: "5.00" }));
    expect(markup).not.toContain("Showing first 200");
  });
});
