import { query } from "./db";
import type { AuditResult } from "./types/seo-audit";

export type SeoAuditRunStatus = "queued" | "running" | "succeeded" | "failed";

export type SeoAuditRunRecord = {
  id: string;
  url: string;
  host: string | null;
  status: SeoAuditRunStatus;
  requestedBy: string;
  maxPages: number;
  result: AuditResult | null;
  seoScore: number | null;
  aeoScore: number | null;
  pagesCrawled: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Cap on stored error messages so a runaway upstream error can't bloat a row. */
const MAX_ERROR_MESSAGE_LENGTH = 2000;

/**
 * Runs stuck in 'queued'/'running' past this many minutes are reaped as
 * stale. Shared by the create route (opportunistic sweep) and the status
 * route (per-run check while polling).
 */
export const STALE_SEO_AUDIT_RUN_MINUTES = 5;

const seoAuditRunSelectColumns = `id,
       url,
       host,
       status,
       requested_by as "requestedBy",
       max_pages as "maxPages",
       result,
       seo_score as "seoScore",
       aeo_score as "aeoScore",
       pages_crawled as "pagesCrawled",
       error,
       started_at as "startedAt",
       finished_at as "finishedAt",
       created_at as "createdAt",
       updated_at as "updatedAt"`;

function truncateErrorMessage(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;
}

export async function createSeoAuditRun(args: {
  url: string;
  maxPages: number;
  requestedBy: string;
}): Promise<SeoAuditRunRecord> {
  const result = await query<SeoAuditRunRecord>(
    `insert into seo_audit_runs (url, max_pages, requested_by, status)
     values ($1, $2, $3, 'queued')
     returning ${seoAuditRunSelectColumns}`,
    [args.url, args.maxPages, args.requestedBy]
  );
  return result.rows[0];
}

/**
 * Transitions a run from 'queued' to 'running'. The `status = 'queued'` guard
 * makes this atomic: if two requests race to start the same run (e.g. a page
 * refresh while the first `/run` call is still in flight), only one update
 * matches a row and the other gets `null` back — the caller should treat
 * that as "already started" rather than starting the audit twice.
 */
export async function markSeoAuditRunRunning(id: string): Promise<SeoAuditRunRecord | null> {
  const result = await query<SeoAuditRunRecord>(
    `update seo_audit_runs
     set status = 'running',
         started_at = now(),
         updated_at = now()
     where id = $1
       and status = 'queued'
     returning ${seoAuditRunSelectColumns}`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function completeSeoAuditRun(
  id: string,
  result: AuditResult
): Promise<SeoAuditRunRecord | null> {
  const updated = await query<SeoAuditRunRecord>(
    `update seo_audit_runs
     set status = 'succeeded',
         result = $2,
         host = $3,
         seo_score = $4,
         aeo_score = $5,
         pages_crawled = $6,
         finished_at = now(),
         updated_at = now()
     where id = $1
     returning ${seoAuditRunSelectColumns}`,
    [id, JSON.stringify(result), result.site.host, result.scores.seo, result.scores.aeo, result.pagesCrawled]
  );
  return updated.rows[0] ?? null;
}

export async function failSeoAuditRun(id: string, errorMessage: string): Promise<SeoAuditRunRecord | null> {
  const result = await query<SeoAuditRunRecord>(
    `update seo_audit_runs
     set status = 'failed',
         error = $2,
         finished_at = now(),
         updated_at = now()
     where id = $1
     returning ${seoAuditRunSelectColumns}`,
    [id, truncateErrorMessage(errorMessage)]
  );
  return result.rows[0] ?? null;
}

/**
 * Loads a run scoped to its owner. This is the ONLY read path route handlers
 * should use — filtering on `requested_by` here (rather than trusting every
 * call site to remember an owner check) is what keeps one user from reading
 * another user's run by id.
 */
export async function getSeoAuditRunForUser(
  id: string,
  requestedBy: string
): Promise<SeoAuditRunRecord | null> {
  const result = await query<SeoAuditRunRecord>(
    `select ${seoAuditRunSelectColumns}
     from seo_audit_runs
     where id = $1
       and requested_by = $2`,
    [id, requestedBy]
  );
  return result.rows[0] ?? null;
}

export async function listSeoAuditRunsForUser(
  requestedBy: string,
  limit: number
): Promise<SeoAuditRunRecord[]> {
  const result = await query<SeoAuditRunRecord>(
    `select ${seoAuditRunSelectColumns}
     from seo_audit_runs
     where requested_by = $1
     order by created_at desc
     limit $2`,
    [requestedBy, limit]
  );
  return result.rows;
}

/**
 * Marks runs stuck in 'queued'/'running' past `olderThanMinutes` as failed.
 * The Netlify function backing the audit route is killed at 60s, so a run
 * that outlives its request leaves an orphaned row with no other way to
 * transition out of 'running'. Called opportunistically before creating a
 * new run, and from the status route when the polled run is itself stale.
 */
export async function reapStaleSeoAuditRuns(olderThanMinutes: number): Promise<number> {
  const result = await query(
    `update seo_audit_runs
     set status = 'failed',
         error = 'Audit timed out before it could finish (reaped as stale).',
         finished_at = now(),
         updated_at = now()
     where status in ('queued', 'running')
       and created_at < now() - ($1 || ' minutes')::interval`,
    [olderThanMinutes]
  );
  return result.rowCount ?? 0;
}
