// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ClientHeader } from "@/components/clients/client-header";

afterEach(cleanup);

const baseClient = {
  id: "c1",
  name: "Acme",
  code: "ACME",
  github_repos: [] as string[],
  domains: [] as string[],
  created_at: "2026-01-01T00:00:00.000Z",
  archived_at: null as string | null
};

describe("<ClientHeader />", () => {
  it("renders name and counts line", () => {
    render(
      <ClientHeader
        client={baseClient}
        stats={{ activeProjectCount: 7, archivedProjectCount: 3, lastActivityAt: null }}
        onEdit={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: /Acme/ })).toBeTruthy();
    expect(screen.getByText(/7 active/)).toBeTruthy();
    expect(screen.getByText(/3 archived/)).toBeTruthy();
  });

  it("shows archived badge only when archived_at set", () => {
    const { rerender } = render(
      <ClientHeader client={baseClient}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.queryByText("Archived")).toBeNull();

    rerender(
      <ClientHeader client={{ ...baseClient, archived_at: "2026-04-01T00:00:00.000Z" }}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.getByText("Archived")).toBeTruthy();
  });

  it("omits repos line when github_repos empty", () => {
    render(
      <ClientHeader client={baseClient}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.queryByText(/Repos:/)).toBeNull();
  });

  it("renders repos line when github_repos has items", () => {
    render(
      <ClientHeader client={{ ...baseClient, github_repos: ["acme/web", "acme/api"] }}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.getByText("Repos:")).toBeTruthy();
    expect(screen.getByRole("link", { name: "acme/web" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "acme/api" })).toBeTruthy();
  });

  it("omits domains line when empty; renders when populated", () => {
    const { rerender } = render(
      <ClientHeader client={baseClient}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.queryByText(/Domains:/)).toBeNull();

    rerender(
      <ClientHeader client={{ ...baseClient, domains: ["acme.com", "app.acme.com"] }}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.getByText("Domains:")).toBeTruthy();
    expect(screen.getByText("acme.com, app.acme.com")).toBeTruthy();
  });

  it("clicking Edit calls onEdit", () => {
    const onEdit = vi.fn();
    render(
      <ClientHeader client={baseClient}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={onEdit} />
    );
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(onEdit).toHaveBeenCalled();
  });
});
