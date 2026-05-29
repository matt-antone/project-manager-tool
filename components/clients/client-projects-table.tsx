"use client";

import Link from "next/link";
import type { ClientProjectRow } from "@/lib/types/client-stats";
import { ClientStatusBadge } from "@/components/clients/client-status-badge";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

export function ClientProjectsTable({
  rows,
  tab
}: {
  rows: ClientProjectRow[];
  tab: "active" | "archived";
}) {
  if (rows.length === 0) {
    return (
      <p className="clientProjectsTableEmpty">
        {tab === "active"
          ? "No active projects for this client."
          : "No archived projects for this client."}
      </p>
    );
  }
  return (
    <table className="clientProjectsTable">
      <thead>
        <tr>
          <th>Project</th>
          <th>Status</th>
          <th>Last activity</th>
          <th>Due</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <Link href={`/projects/${r.id}`} prefetch={false}>
                {r.name}
              </Link>
            </td>
            <td><ClientStatusBadge status={r.status} /></td>
            <td>{fmt(r.last_activity_at)}</td>
            <td>{r.deadline ? r.deadline : "—"}</td>
            <td>{fmt(r.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
