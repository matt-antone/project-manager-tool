/**
 * Shape of the audit payload produced by `runApiAudit` in
 * `@matt-antone/seo-audit/src/audit-api.js`.
 *
 * The upstream package is plain JavaScript with no bundled types, so this file
 * is the hand-maintained contract. It mirrors the hosted-API path only: that
 * path parses with linkedom and never renders, so `site.rendersUsed` stays 0
 * and no finding is tagged `verifiedBy: "rendered"`.
 *
 * Do not read `site.playwright` as "this run rendered". Verified against a live
 * run of `runApiAudit`: it reports `true` even on the linkedom path, where
 * `rendersUsed` is 0 and every page is `verifiedBy: "raw"`. It reflects module
 * availability, not use. `rendersUsed` is the field that answers that question.
 */

export type AuditSeverity = "critical" | "high" | "medium" | "low";
export type AuditCategory = "seo" | "aeo";
export type AuditVerifiedBy = "http" | "raw" | "rendered";

export type AuditRobots = {
  present: boolean;
  sitemaps: string[];
};

export type AuditAiBot = {
  allowed: boolean;
  via: string;
  vendor: string;
};

export type AuditLlmsTxt = {
  present: boolean;
  status: number | null;
};

export type AuditSite = {
  base: string;
  host: string;
  robots: AuditRobots;
  /** Keyed by user-agent, e.g. "GPTBot", "ClaudeBot". */
  aiBots: Record<string, AuditAiBot>;
  llmsTxt: AuditLlmsTxt;
  /** Null when the probe itself failed, so absence is distinguishable from false. */
  hard404: boolean | null;
  sitemaps: string[];
  sitemapUrlCount: number;
  playwright: boolean;
  rendersUsed: number;
};

export type AuditPage = {
  url: string;
  status: number;
  finalUrl: string;
  verifiedBy: string;
  title: string | null;
  metaDescription: string | null;
  wordCount: number;
  jsonldTypes: string[];
};

export type AuditFinding = {
  /** Check id, e.g. "title-missing". Stable key into the upstream CHECKS registry. */
  check: string;
  severity: AuditSeverity;
  category: AuditCategory;
  title: string;
  /** Null for site-level findings that are not tied to a single page. */
  page: string | null;
  message: string;
  evidence: string | null;
  verifiedBy: AuditVerifiedBy;
};

export type AuditScores = {
  seo: number;
  aeo: number;
};

export type AuditResult = {
  tool: string;
  /** ISO-8601. */
  auditedAt: string;
  site: AuditSite;
  pagesCrawled: number;
  pages: AuditPage[];
  findings: AuditFinding[];
  scores: AuditScores;
};

const AUDIT_SEVERITY_ORDER: AuditSeverity[] = ["critical", "high", "medium", "low"];

/** Sort key for rendering findings worst-first. Unknown severities sort last. */
export function severityRank(severity: AuditSeverity): number {
  const rank = AUDIT_SEVERITY_ORDER.indexOf(severity);
  return rank === -1 ? AUDIT_SEVERITY_ORDER.length : rank;
}

export function countBySeverity(findings: AuditFinding[]): Record<AuditSeverity, number> {
  const counts: Record<AuditSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    if (finding.severity in counts) {
      counts[finding.severity] += 1;
    }
  }
  return counts;
}

export type ScoreBand = "good" | "ok" | "poor";

/**
 * Score band thresholds shared by the screen results page and the PDF
 * renderer, so the same run reads the same band in both places. Matches
 * Google Lighthouse's score bands (>=90 green, 50-89 orange, <50 red) — a
 * convention already familiar from other audit tooling, and a middle ground
 * between the two thresholds this codebase previously used independently
 * (80/50 on screen, 90/70 in the PDF).
 *
 * Deliberately not exported. `scoreBand()` is the only intended entry point —
 * exporting the raw numbers is what let the screen and the PDF drift apart in
 * the first place.
 */
const SCORE_BAND_GOOD_MIN = 90;
const SCORE_BAND_OK_MIN = 50;

/** Classifies a 0-100 score into its band. Callers map the band to color/class. */
export function scoreBand(score: number): ScoreBand {
  if (score >= SCORE_BAND_GOOD_MIN) return "good";
  if (score >= SCORE_BAND_OK_MIN) return "ok";
  return "poor";
}
