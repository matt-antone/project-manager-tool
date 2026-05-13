"use client";

import type { ClientTabCounts } from "@/lib/types/client-stats";

type Tab = "active" | "archived";

export function ClientTabs({
  current,
  counts,
  onChange
}: {
  current: Tab;
  counts: ClientTabCounts;
  onChange: (next: Tab) => void;
}) {
  return (
    <div role="tablist" className="clientTabs">
      <button
        type="button"
        role="tab"
        aria-selected={current === "active"}
        onClick={() => onChange("active")}
      >
        Active ({counts.active})
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={current === "archived"}
        onClick={() => onChange("archived")}
      >
        Archived ({counts.archived})
      </button>
    </div>
  );
}
