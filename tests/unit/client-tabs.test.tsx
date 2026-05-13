// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ClientTabs } from "@/components/clients/client-tabs";

afterEach(() => {
  cleanup();
});

describe("<ClientTabs />", () => {
  it("renders both labels with counts", () => {
    render(
      <ClientTabs current="active" counts={{ active: 12, archived: 5 }} onChange={() => {}} />
    );
    expect(screen.getByRole("tab", { name: /Active \(12\)/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Archived \(5\)/ })).toBeTruthy();
  });

  it("marks the current tab as selected", () => {
    render(
      <ClientTabs current="archived" counts={{ active: 12, archived: 5 }} onChange={() => {}} />
    );
    expect(screen.getByRole("tab", { selected: true }).textContent).toMatch(/Archived/);
  });

  it("calls onChange when clicking the other tab", () => {
    const onChange = vi.fn();
    render(
      <ClientTabs current="active" counts={{ active: 1, archived: 1 }} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /Archived/ }));
    expect(onChange).toHaveBeenCalledWith("archived");
  });
});
