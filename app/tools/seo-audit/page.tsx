"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authedJsonFetch, fetchAuthSession } from "@/lib/browser-auth";
import { PageLoadingState } from "@/components/loading-shells";
import type { SeoAuditRunRecord } from "@/lib/seo-audit-repository";

const RECENT_RUNS_LIMIT = 10;

function formatRunDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function formatRunStatus(status: SeoAuditRunRecord["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function formatScore(score: number | null): string {
  return typeof score === "number" ? String(score) : "—";
}

export default function SeoAuditToolPage() {
  const router = useRouter();

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [runs, setRuns] = useState<SeoAuditRunRecord[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const session = await fetchAuthSession();
        if (!session?.accessToken) {
          if (!cancelled) {
            setAuthError("Sign in required");
            setBootstrapped(true);
          }
          return;
        }
        if (cancelled) return;
        setAccessToken(session.accessToken);
        try {
          const { data } = await authedJsonFetch({
            accessToken: session.accessToken,
            path: `/api/tools/seo-audit?limit=${RECENT_RUNS_LIMIT}`
          });
          if (cancelled) return;
          setRuns((data as { runs: SeoAuditRunRecord[] }).runs ?? []);
        } catch (err) {
          if (!cancelled) {
            setRunsError(err instanceof Error ? err.message : "Failed to load recent audits");
          }
        }
      } finally {
        if (!cancelled) setBootstrapped(true);
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) {
      setSubmitError("Sign in required");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { data } = await authedJsonFetch({
        accessToken,
        path: "/api/tools/seo-audit",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim() })
        }
      });
      const runId = (data as { runId: string }).runId;
      router.push(`/tools/seo-audit/${runId}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to start audit");
      setSubmitting(false);
    }
  }

  if (!bootstrapped) {
    return <PageLoadingState label="SEO Audit" message="Loading..." />;
  }

  if (authError) {
    return (
      <main className="toolsPage">
        <p role="alert">{authError}</p>
      </main>
    );
  }

  return (
    <main className="toolsPage">
      <header className="toolsPageHeader">
        <h1 className="toolsPageTitle">SEO Audit</h1>
        <p className="toolsPageSubtitle">Audit a URL for SEO and AI-readiness issues.</p>
      </header>

      <section className="toolsCard" aria-labelledby="seo-audit-tool-heading">
        <h2 id="seo-audit-tool-heading" className="toolsCardTitle">
          Run an audit
        </h2>
        <p className="toolsCardHint">
          Enter a URL to crawl and audit. We&apos;ll queue the audit and take you straight to its results page,
          where it runs and updates automatically.
        </p>

        <form onSubmit={handleSubmit} className="toolsForm">
          <label className="toolsFieldLabel" htmlFor="seo-audit-url">
            URL
          </label>
          <input
            id="seo-audit-url"
            className="toolsInput"
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com"
            required
            disabled={submitting}
          />

          {submitError ? (
            <p role="alert" className="toolsError">
              {submitError}
            </p>
          ) : null}

          <div className="toolsFormActions">
            <button
              type="submit"
              className="themeHeaderButton themeHeaderButtonPrimary"
              disabled={submitting || !url.trim()}
            >
              {submitting ? "Starting…" : "Run audit"}
            </button>
          </div>
        </form>
      </section>

      <section className="toolsCard" aria-labelledby="seo-audit-recent-heading">
        <h2 id="seo-audit-recent-heading" className="toolsCardTitle">
          Recent audits
        </h2>

        {runsError ? (
          <p role="alert" className="toolsError">
            {runsError}
          </p>
        ) : runs.length === 0 ? (
          <p className="toolsCardHint">No audits yet. Run one above to see it here.</p>
        ) : (
          <ul className="toolsRunsList">
            {runs.map((run) => (
              <li key={run.id}>
                <Link href={`/tools/seo-audit/${run.id}`} className="toolsRunRow">
                  <div className="toolsRunRowMain">
                    <span className="toolsRunHost">{run.host ?? run.url}</span>
                    <span className="toolsRunDate">{formatRunDate(run.createdAt)}</span>
                  </div>
                  <div className="toolsRunRowMeta">
                    <span className={`toolsRunStatus toolsRunStatus-${run.status}`}>
                      {formatRunStatus(run.status)}
                    </span>
                    <span className="toolsRunScores">
                      SEO {formatScore(run.seoScore)} · AEO {formatScore(run.aeoScore)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
