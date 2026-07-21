"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { authedJsonFetch, ensureAccessToken, fetchAuthSession } from "@/lib/browser-auth";
import { triggerBrowserDownload } from "@/lib/browser-download";
import { PageLoadingState } from "@/components/loading-shells";
import {
  countBySeverity,
  scoreBand,
  severityRank,
  type AuditCategory,
  type AuditFinding,
  type AuditSeverity,
  type ScoreBand
} from "@/lib/types/seo-audit";
import type { SeoAuditRunRecord } from "@/lib/seo-audit-repository";

const SEO_AUDIT_POLL_INTERVAL_MS = 3000;

/** Ceiling on total time spent polling a single run, so a stuck run can't poll forever. */
const SEO_AUDIT_POLL_MAX_DURATION_MS = 5 * 60 * 1000;

/** CSS class for each shared score band. Band decision lives in lib/types/seo-audit.ts. */
const SCORE_BAND_CLASS: Record<ScoreBand, string> = {
  good: "toolsScoreGood",
  ok: "toolsScoreOk",
  poor: "toolsScoreBad"
};

const CATEGORY_ORDER: AuditCategory[] = ["seo", "aeo"];
const CATEGORY_LABELS: Record<AuditCategory, string> = {
  seo: "SEO findings",
  aeo: "AEO findings (AI readiness)"
};
const SEVERITY_LABELS: Record<AuditSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low"
};

function scoreBandClass(score: number): string {
  return SCORE_BAND_CLASS[scoreBand(score)];
}

function groupFindingsByCategory(findings: AuditFinding[]): Record<AuditCategory, AuditFinding[]> {
  const groups: Record<AuditCategory, AuditFinding[]> = { seo: [], aeo: [] };
  for (const finding of findings) {
    if (finding.category in groups) {
      groups[finding.category].push(finding);
    }
  }
  for (const category of CATEGORY_ORDER) {
    groups[category].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  }
  return groups;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function sanitizeHostForFilename(host: string): string {
  const cleaned = host.trim().toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  return cleaned || "site";
}

export default function SeoAuditResultPage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId;

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [run, setRun] = useState<SeoAuditRunRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pollTimedOut, setPollTimedOut] = useState(false);

  const [pdfPending, setPdfPending] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // Guards against firing POST /run twice — once is enough, and React
  // strict-mode double-invokes effects in dev.
  const runTriggeredRef = useRef(false);
  // Persists the wall-clock start of polling across status transitions
  // (queued -> running) so the max-duration ceiling covers the whole visit,
  // not just the most recent status.
  const pollStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const session = await fetchAuthSession();
        if (!session?.accessToken) {
          if (!cancelled) {
            setAuthError("Sign in required");
            setLoading(false);
          }
          return;
        }
        if (cancelled) return;
        setAccessToken(session.accessToken);
        const { data } = await authedJsonFetch({
          accessToken: session.accessToken,
          path: `/api/tools/seo-audit/${runId}`
        });
        if (cancelled) return;
        setRun((data as { run: SeoAuditRunRecord }).run);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load audit run");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Kick off the audit exactly once when the run is still queued. The POST
  // itself executes the audit synchronously (up to ~60s) and returns the
  // resulting run, but the poll effect below also keeps refreshing status in
  // the meantime so the UI doesn't sit frozen while it waits.
  useEffect(() => {
    if (!accessToken || !run) return;
    if (run.status !== "queued") return;
    if (runTriggeredRef.current) return;
    runTriggeredRef.current = true;

    let cancelled = false;

    async function triggerRun(token: string, retried = false): Promise<void> {
      const response = await fetch(`/api/tools/seo-audit/${runId}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.status === 409) {
        // Another trigger (e.g. a second tab, or strict-mode's other
        // invocation) already started this run — benign, not an error.
        return;
      }
      if (response.status === 401 && !retried) {
        const refreshed = await ensureAccessToken(null, setAccessToken);
        return triggerRun(refreshed, true);
      }

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
            ? (payload as { error: string }).error
            : `Request failed: ${response.status}`;
        throw new Error(message);
      }

      const nextRun = (payload as { run: SeoAuditRunRecord } | null)?.run;
      if (!cancelled && nextRun) {
        setRun(nextRun);
      }
    }

    triggerRun(accessToken).catch((err) => {
      if (!cancelled) {
        setLoadError(err instanceof Error ? err.message : "Failed to start audit run");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [accessToken, run?.status, runId]);

  // Poll while the run is still in flight; stop as soon as it reaches a
  // terminal state, on a poll failure, or after the max duration ceiling —
  // and always clean up the interval on unmount.
  useEffect(() => {
    if (!accessToken || !run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (pollStartedAtRef.current === null) {
      pollStartedAtRef.current = Date.now();
    }
    const startedAt = pollStartedAtRef.current;

    let cancelled = false;
    const stopPolling = () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > SEO_AUDIT_POLL_MAX_DURATION_MS) {
        setPollTimedOut(true);
        stopPolling();
        return;
      }
      try {
        const { data } = await authedJsonFetch({
          accessToken,
          path: `/api/tools/seo-audit/${runId}`
        });
        if (cancelled) return;
        setRun((data as { run: SeoAuditRunRecord }).run);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to refresh audit run");
        stopPolling();
      }
    };

    const intervalId = window.setInterval(() => {
      void poll();
    }, SEO_AUDIT_POLL_INTERVAL_MS);

    return () => {
      stopPolling();
    };
  }, [accessToken, run?.status, runId]);

  async function handleDownloadPdf() {
    if (!accessToken || !run) return;
    setPdfPending(true);
    setPdfError(null);
    try {
      const host = sanitizeHostForFilename(run.host ?? run.result?.site.host ?? "site");
      const date = new Date().toISOString().slice(0, 10);
      const downloadArgs = {
        url: `/api/tools/seo-audit/${runId}/pdf`,
        filename: `seo-audit-${host}-${date}.pdf`
      };
      try {
        await triggerBrowserDownload({
          ...downloadArgs,
          init: { headers: { Authorization: `Bearer ${accessToken}` } }
        });
      } catch (err) {
        // The access token captured at bootstrap may have expired if this
        // page was left open — refresh it and retry the download once.
        if (err instanceof Error && err.message === "Download failed: 401") {
          const refreshed = await ensureAccessToken(null, setAccessToken);
          await triggerBrowserDownload({
            ...downloadArgs,
            init: { headers: { Authorization: `Bearer ${refreshed}` } }
          });
        } else {
          throw err;
        }
      }
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : "Failed to download PDF");
    } finally {
      setPdfPending(false);
    }
  }

  if (loading) {
    return <PageLoadingState label="SEO Audit" message="Loading audit..." />;
  }

  if (authError) {
    return (
      <main className="toolsPage">
        <p role="alert">{authError}</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="toolsPage">
        <p role="alert">{loadError}</p>
      </main>
    );
  }

  if (pollTimedOut) {
    return (
      <main className="toolsPage">
        <p role="alert">
          This audit is taking longer than expected. It may still finish — check back on the{" "}
          <Link href="/tools/seo-audit" className="linkButton">
            SEO Audit
          </Link>{" "}
          page shortly, or reload this page to resume checking.
        </p>
      </main>
    );
  }

  if (!run) {
    return (
      <main className="toolsPage">
        <p role="alert">Audit run not found.</p>
      </main>
    );
  }

  const result = run.result;
  const groupedFindings = result ? groupFindingsByCategory(result.findings) : null;
  const severityCounts = result ? countBySeverity(result.findings) : null;

  return (
    <main className="toolsPage toolsResultPage">
      <div className="toolsResultBackRow">
        <Link href="/tools/seo-audit" className="linkButton">
          ← Back to SEO Audit
        </Link>
      </div>

      <div className="toolsPollingStatus" role="status" aria-live="polite">
        {run.status === "queued" ? "Starting your audit…" : null}
        {run.status === "running"
          ? "Audit in progress — this can take up to a minute. Feel free to leave this page open; it updates automatically."
          : null}
        {run.status === "succeeded" ? "Audit complete." : null}
        {run.status === "failed" ? "Audit failed." : null}
      </div>

      {run.status === "failed" ? (
        <section className="toolsCard">
          <h1 className="toolsCardTitle">Audit failed</h1>
          <p role="alert" className="toolsError">
            {run.error ?? "The audit failed for an unknown reason."}
          </p>
        </section>
      ) : null}

      {(run.status === "queued" || run.status === "running") && !result ? (
        <section className="toolsCard">
          <h1 className="toolsCardTitle">{run.host ?? run.url}</h1>
          <p className="toolsCardHint">
            Crawling and scoring the site now — this can take up to a minute. This page updates automatically, so
            there&apos;s no need to refresh.
          </p>
        </section>
      ) : null}

      {run.status === "succeeded" && result ? (
        <>
          <section className="toolsCard toolsResultHeader">
            <h1 className="toolsCardTitle">{result.site.host}</h1>
            <p className="toolsResultUrl">{result.site.base}</p>
            <dl className="toolsResultMeta">
              <div>
                <dt>Audited</dt>
                <dd>{formatDateTime(result.auditedAt)}</dd>
              </div>
              <div>
                <dt>Pages crawled</dt>
                <dd>{result.pagesCrawled}</dd>
              </div>
            </dl>
          </section>

          <section className="toolsCard toolsScoreSection" aria-labelledby="seo-audit-scores-heading">
            <h2 id="seo-audit-scores-heading" className="toolsCardTitle">
              Scores
            </h2>
            <div className="toolsScoreRow">
              <div className={`toolsScoreCard ${scoreBandClass(result.scores.seo)}`}>
                <span className="toolsScoreValue">{result.scores.seo}</span>
                <span className="toolsScoreLabel">SEO / 100</span>
              </div>
              <div className={`toolsScoreCard ${scoreBandClass(result.scores.aeo)}`}>
                <span className="toolsScoreValue">{result.scores.aeo}</span>
                <span className="toolsScoreLabel">AEO / 100</span>
              </div>
            </div>
          </section>

          {severityCounts ? (
            <section className="toolsCard" aria-labelledby="seo-audit-severity-heading">
              <h2 id="seo-audit-severity-heading" className="toolsCardTitle">
                Findings by severity
              </h2>
              <ul className="toolsSeverityRollup">
                {(Object.keys(SEVERITY_LABELS) as AuditSeverity[]).map((severity) => (
                  <li key={severity} className={`toolsSeverityChip toolsSeverityChip-${severity}`}>
                    <span className="toolsSeverityChipCount">{severityCounts[severity]}</span>
                    <span className="toolsSeverityChipLabel">{SEVERITY_LABELS[severity]}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="toolsFormActions">
            <button
              type="button"
              className="themeHeaderButton themeHeaderButtonPrimary"
              onClick={() => handleDownloadPdf().catch(() => undefined)}
              disabled={pdfPending}
            >
              {pdfPending ? "Preparing PDF…" : "Download PDF"}
            </button>
          </div>
          {pdfError ? (
            <p role="alert" className="toolsError">
              {pdfError}
            </p>
          ) : null}

          {groupedFindings
            ? CATEGORY_ORDER.map((category) => (
                <section key={category} className="toolsCard" aria-labelledby={`seo-audit-findings-${category}`}>
                  <h2 id={`seo-audit-findings-${category}`} className="toolsCardTitle">
                    {CATEGORY_LABELS[category]}
                  </h2>
                  {groupedFindings[category].length === 0 ? (
                    <p className="toolsCardHint">No {category.toUpperCase()} findings.</p>
                  ) : (
                    <ul className="toolsFindingsList">
                      {groupedFindings[category].map((finding, index) => (
                        <li key={`${finding.check}-${index}`} className="toolsFindingCard">
                          <div className="toolsFindingHead">
                            <span className={`toolsSeverityBadge toolsSeverityBadge-${finding.severity}`}>
                              {SEVERITY_LABELS[finding.severity]}
                            </span>
                            <span className="toolsFindingTitle">{finding.title}</span>
                          </div>
                          <p className="toolsFindingMessage">{finding.message}</p>
                          <p className="toolsFindingMeta">{finding.page ?? "Site-wide"}</p>
                          {finding.evidence ? (
                            <pre className="toolsFindingEvidence">{finding.evidence}</pre>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))
            : null}

          <section className="toolsCard" aria-labelledby="seo-audit-pages-heading">
            <h2 id="seo-audit-pages-heading" className="toolsCardTitle">
              Crawled pages
            </h2>
            {result.pages.length === 0 ? (
              <p className="toolsCardHint">No pages were crawled.</p>
            ) : (
              <div className="toolsPagesTableWrap">
                <table className="toolsPagesTable">
                  <thead>
                    <tr>
                      <th scope="col">URL</th>
                      <th scope="col">Status</th>
                      <th scope="col">Title</th>
                      <th scope="col">Words</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.pages.map((page) => (
                      <tr key={page.url}>
                        <td className="toolsPagesTableUrl">{page.url}</td>
                        <td>{page.status}</td>
                        <td>{page.title ?? "—"}</td>
                        <td>{page.wordCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}
