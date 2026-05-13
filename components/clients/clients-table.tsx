"use client";

import Link from "next/link";
import type { ClientWithStats } from "@/lib/types/client-stats";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

export function ClientsTable({
  rows,
  tab
}: {
  rows: ClientWithStats[];
  tab: "active" | "archived";
}) {
  if (rows.length === 0) {
    return (
      <p className="clientsTableEmpty">
        {tab === "active" ? "No active clients." : "No archived clients."}
      </p>
    );
  }

  return (
    <table className="clientsTable">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Active projects</th>
          <th scope="col">Last activity</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <Link href={`/clients/${r.id}`} prefetch={false}>
                {r.name}
              </Link>
            </td>
            <td>{r.active_project_count}</td>
            <td>{formatDate(r.last_activity_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
