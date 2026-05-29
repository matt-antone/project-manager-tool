// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ClientProjectsTable } from "@/components/clients/client-projects-table";
import type { ClientProjectRow } from "@/lib/types/client-stats";

afterEach(cleanup);

const row = (o: Partial<ClientProjectRow> = {}): ClientProjectRow => ({
  id: "p1",
  name: "Website redesign",
  status: "in_progress",
  last_activity_at: "2026-05-10T00:00:00.000Z",
  deadline: "2026-06-01",
  created_at: "2026-03-14T00:00:00.000Z",
  ...o
});

describe("<ClientProjectsTable />", () => {
  it("renders project row linking to /projects/[id]", () => {
    render(<ClientProjectsTable rows={[row()]} tab="active" />);
    const link = screen.getByRole("link", { name: /Website redesign/ });
    expect(link.getAttribute("href")).toBe("/projects/p1");
  });

  it("renders status badge with the status label", () => {
    render(<ClientProjectsTable rows={[row()]} tab="active" />);
    expect(screen.getByLabelText("in progress")).toBeTruthy();
  });

  it("renders em dash for null deadline and null last_activity_at", () => {
    render(
      <ClientProjectsTable rows={[row({ deadline: null, last_activity_at: null })]} tab="active" />
    );
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("renders active empty state", () => {
    render(<ClientProjectsTable rows={[]} tab="active" />);
    expect(screen.getByText(/No active projects for this client/i)).toBeTruthy();
  });

  it("renders archived empty state", () => {
    render(<ClientProjectsTable rows={[]} tab="archived" />);
    expect(screen.getByText(/No archived projects for this client/i)).toBeTruthy();
  });
});
