"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { authedJsonFetch, fetchAuthSession } from "@/lib/browser-auth";
import { PageLoadingState } from "@/components/loading-shells";
import { ClientHeader } from "@/components/clients/client-header";
import { ClientTabs } from "@/components/clients/client-tabs";
import { ClientProjectsTable } from "@/components/clients/client-projects-table";
import { ClientEditDialog } from "@/components/clients/client-edit-dialog";
import type { ClientRecord } from "@/lib/types/client-record";
import type {
  ClientDetailStats,
  ClientProjectRow
} from "@/lib/types/client-stats";

type Tab = "active" | "archived";

function parseTab(raw: string | null): Tab {
  return raw === "archived" ? "archived" : "active";
}

export default function ClientDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const clientId = String(params?.id ?? "");
  const tab = parseTab(searchParams.get("tab"));

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [stats, setStats] = useState<ClientDetailStats | null>(null);
  const [projects, setProjects] = useState<ClientProjectRow[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const session = await fetchAuthSession();
        if (!session?.accessToken) {
          setError("Sign in required");
          return;
        }
        if (cancelled) return;
        setAccessToken(session.accessToken);
        const res = await fetch(`/clients/${clientId}?stats=1`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
          credentials: "same-origin"
        });
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const payload = (await res.json()) as {
          client: ClientRecord;
          stats: ClientDetailStats;
        };
        if (cancelled) return;
        setClient(payload.client);
        setStats(payload.stats);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      }
    }
    if (clientId) bootstrap();
    return () => { cancelled = true; };
  }, [clientId]);

  useEffect(() => {
    if (!accessToken || !clientId) return;
    let cancelled = false;
    setProjects(null);
    (async () => {
      try {
        const { data } = await authedJsonFetch({
          accessToken,
          path: `/clients/${clientId}/projects?filter=${tab}`
        });
        if (cancelled) return;
        setProjects((data as { projects: ClientProjectRow[] }).projects);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load projects");
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, clientId, tab]);

  function handleTabChange(next: Tab) {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("tab", next);
    router.replace(`/clients/${clientId}?${sp.toString()}`);
  }

  if (notFound) return <p>Client not found.</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!client || !stats) return <PageLoadingState label="Client" message="Loading client..." />;

  return (
    <div className="clientDetailPage">
      <ClientHeader
        client={client}
        stats={stats}
        onEdit={() => setEditOpen(true)}
      />
      <ClientTabs
        current={tab}
        counts={{ active: stats.activeProjectCount, archived: stats.archivedProjectCount }}
        onChange={handleTabChange}
      />
      {projects === null ? (
        <p>Loading projects...</p>
      ) : (
        <ClientProjectsTable rows={projects} tab={tab} />
      )}
      {accessToken ? (
        <ClientEditDialog
          client={client}
          accessToken={accessToken}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={(next) => setClient(next)}
        />
      ) : null}
    </div>
  );
}
