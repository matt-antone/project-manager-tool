// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ClientsTable } from "@/components/clients/clients-table";
import type { ClientWithStats } from "@/lib/types/client-stats";

afterEach(cleanup);

const row = (overrides: Partial<ClientWithStats> = {}): ClientWithStats => ({
  id: "c1",
  name: "Acme Corp",
  code: "ACME",
  github_repos: [],
  domains: [],
  created_at: "2026-01-01T00:00:00.000Z",
  archived_at: null,
  active_project_count: 7,
  last_activity_at: "2026-05-10T12:00:00.000Z",
  ...overrides
});

describe("<ClientsTable />", () => {
  it("renders row with name link to detail page", () => {
    render(<ClientsTable rows={[row()]} tab="active" />);
    const link = screen.getByRole("link", { name: /Acme Corp/ });
    expect(link.getAttribute("href")).toBe("/clients/c1");
  });

  it("renders active project count and last activity", () => {
    render(<ClientsTable rows={[row()]} tab="active" />);
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText(/2026-05-10/)).toBeTruthy();
  });

  it("renders em dash for null last activity", () => {
    render(<ClientsTable rows={[row({ last_activity_at: null })]} tab="active" />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders active empty state", () => {
    render(<ClientsTable rows={[]} tab="active" />);
    expect(screen.getByText(/No active clients/i)).toBeTruthy();
  });

  it("renders archived empty state", () => {
    render(<ClientsTable rows={[]} tab="archived" />);
    expect(screen.getByText(/No archived clients/i)).toBeTruthy();
  });
});
