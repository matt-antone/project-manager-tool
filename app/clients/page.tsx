"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authedJsonFetch, fetchAuthSession } from "@/lib/browser-auth";
import { PageLoadingState } from "@/components/loading-shells";
import { ClientTabs } from "@/components/clients/client-tabs";
import { ClientsTable } from "@/components/clients/clients-table";
import type { ClientTabCounts, ClientWithStats } from "@/lib/types/client-stats";

type Tab = "active" | "archived";

function parseTab(raw: string | null): Tab {
  return raw === "archived" ? "archived" : "active";
}

function ClientsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = parseTab(searchParams.get("tab"));

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [data, setData] = useState<{
    active: ClientWithStats[];
    archived: ClientWithStats[];
    counts: ClientTabCounts;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        const { data: payload } = await authedJsonFetch({
          accessToken: session.accessToken,
          path: "/api/clients?stats=1"
        });
        if (cancelled) return;
        setData(payload as typeof data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load clients");
        }
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    return tab === "active" ? data.active : data.archived;
  }, [data, tab]);

  function handleTabChange(next: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`/clients?${params.toString()}`);
  }

  if (error) return <p role="alert">{error}</p>;
  if (!data || !accessToken) return <PageLoadingState label="Clients" message="Loading clients..." />;

  return (
    <div className="clientsPage">
      <h1>Clients</h1>
      <ClientTabs current={tab} counts={data.counts} onChange={handleTabChange} />
      <ClientsTable rows={rows} tab={tab} />
    </div>
  );
}

export default function ClientsPage() {
  return (
    <Suspense fallback={<PageLoadingState label="Clients" message="Loading clients..." />}>
      <ClientsPageInner />
    </Suspense>
  );
}
