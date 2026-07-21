import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import {
  type AuditCategory,
  type AuditFinding,
  type AuditResult,
  type AuditSeverity,
  type ScoreBand,
  countBySeverity,
  scoreBand,
  severityRank
} from "@/lib/types/seo-audit";

const SCORE_COLOR_GOOD = "#15803d";
const SCORE_COLOR_OK = "#b45309";
const SCORE_COLOR_POOR = "#b91c1c";

/** Color mapping for each shared score band. Band decision lives in lib/types/seo-audit.ts. */
const SCORE_BAND_COLORS: Record<ScoreBand, string> = {
  good: SCORE_COLOR_GOOD,
  ok: SCORE_COLOR_OK,
  poor: SCORE_COLOR_POOR
};

const CATEGORY_ORDER: AuditCategory[] = ["seo", "aeo"];

const CATEGORY_LABELS: Record<AuditCategory, string> = {
  seo: "SEO Findings",
  aeo: "AEO Findings"
};

const SEVERITY_LABELS: Record<AuditSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low"
};

const SEVERITY_COLORS: Record<AuditSeverity, { background: string; text: string }> = {
  critical: { background: "#fee2e2", text: "#991b1b" },
  high: { background: "#ffedd5", text: "#9a3412" },
  medium: { background: "#fef3c7", text: "#92400e" },
  low: { background: "#dbeafe", text: "#1e40af" }
};

const EVIDENCE_MAX_LENGTH = 500;

type AuditPdfDocumentProps = {
  result: AuditResult;
};

export function AuditPdfDocument({ result }: AuditPdfDocumentProps) {
  const { site, scores, findings, pages, pagesCrawled, auditedAt, tool } = result;
  const severityCounts = countBySeverity(findings);
  const findingsByCategory = CATEGORY_ORDER.map((category) => ({
    category,
    findings: findings.filter((finding) => finding.category === category).sort(byWorstSeverityFirst)
  })).filter((group) => group.findings.length > 0);

  return (
    <Document title={`SEO Audit Report — ${site.host}`}>
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.header}>
          <Text style={styles.headline}>{site.host}</Text>
          <Text style={styles.baseUrl}>{site.base}</Text>
          <View style={styles.headerMetaRow}>
            <Text style={styles.headerMetaItem}>Audited {formatTimestamp(auditedAt)}</Text>
            <Text style={styles.headerMetaItem}>{pagesCrawled} pages crawled</Text>
            <Text style={styles.headerMetaItem}>{tool}</Text>
          </View>
        </View>

        <View style={styles.scoreRow} wrap={false}>
          <ScoreCard label="SEO Score" score={scores.seo} />
          <ScoreCard label="AEO Score" score={scores.aeo} />
        </View>

        <View style={styles.severityRollup} wrap={false}>
          {(Object.keys(SEVERITY_LABELS) as AuditSeverity[]).map((severity) => (
            <View key={severity} style={styles.severityRollupItem}>
              <Text style={[styles.severityRollupCount, { color: SEVERITY_COLORS[severity].text }]}>
                {severityCounts[severity]}
              </Text>
              <Text style={styles.severityRollupLabel}>{SEVERITY_LABELS[severity]}</Text>
            </View>
          ))}
        </View>

        {findingsByCategory.length === 0 ? (
          <View style={styles.emptyState} wrap={false}>
            <Text style={styles.emptyStateText}>No issues found.</Text>
          </View>
        ) : (
          findingsByCategory.map((group) => (
            <View key={group.category} style={styles.section}>
              <Text style={styles.sectionTitle}>{CATEGORY_LABELS[group.category]}</Text>
              {group.findings.map((finding, index) => (
                <FindingRow key={`${finding.check}-${finding.page ?? "site"}-${index}`} finding={finding} />
              ))}
            </View>
          ))
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Crawled Pages</Text>
          {pages.length === 0 ? (
            <View style={styles.emptyState} wrap={false}>
              <Text style={styles.emptyStateText}>No pages were crawled.</Text>
            </View>
          ) : (
            <View style={styles.table}>
              <View style={styles.tableHeaderRow} wrap={false}>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colUrl]}>URL</Text>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colStatus]}>Status</Text>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colTitle]}>Title</Text>
                <Text style={[styles.tableCell, styles.tableHeaderText, styles.colWordCount]}>Words</Text>
              </View>
              {pages.map((page, index) => (
                <View
                  key={`${page.url}-${index}`}
                  style={index % 2 === 1 ? [styles.tableRow, styles.tableRowAlt] : styles.tableRow}
                  wrap={false}
                >
                  <Text style={[styles.tableCell, styles.colUrl, styles.wordBreakAll]}>{page.url}</Text>
                  <Text style={[styles.tableCell, styles.colStatus]}>{page.status}</Text>
                  <Text style={[styles.tableCell, styles.colTitle]}>{truncateText(page.title ?? "—", 90)}</Text>
                  <Text style={[styles.tableCell, styles.colWordCount]}>{page.wordCount}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) => `${site.host} · Page ${pageNumber} of ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

function ScoreCard({ label, score }: { label: string; score: number }) {
  return (
    <View style={styles.scoreCard} wrap={false}>
      <Text style={[styles.scoreValue, { color: getScoreColor(score) }]}>{Math.round(score)}</Text>
      <Text style={styles.scoreOutOf}>/ 100</Text>
      <Text style={styles.scoreLabel}>{label}</Text>
    </View>
  );
}

function FindingRow({ finding }: { finding: AuditFinding }) {
  const severityColors = SEVERITY_COLORS[finding.severity];
  const pageLabel = finding.page ?? "Site-wide";

  return (
    <View style={styles.findingCard} wrap={false}>
      <View style={styles.findingHeaderRow}>
        <View style={[styles.severityBadge, { backgroundColor: severityColors.background }]}>
          <Text style={[styles.severityBadgeText, { color: severityColors.text }]}>
            {SEVERITY_LABELS[finding.severity]}
          </Text>
        </View>
        <Text style={styles.findingTitle}>{finding.title}</Text>
      </View>
      <Text style={styles.findingMessage}>{finding.message}</Text>
      <Text style={[styles.findingPage, styles.wordBreakAll]}>{pageLabel}</Text>
      {finding.evidence ? <Text style={styles.findingEvidence}>{truncateEvidence(finding.evidence)}</Text> : null}
    </View>
  );
}

function byWorstSeverityFirst(a: AuditFinding, b: AuditFinding): number {
  return severityRank(a.severity) - severityRank(b.severity);
}

function getScoreColor(score: number): string {
  return SCORE_BAND_COLORS[scoreBand(score)];
}

function truncateEvidence(evidence: string): string {
  const trimmed = evidence.trim();
  if (trimmed.length <= EVIDENCE_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, EVIDENCE_MAX_LENGTH)}…`;
}

function truncateText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}…`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 40,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: "#111827"
  },
  header: {
    marginBottom: 20,
    borderBottomWidth: 2,
    borderBottomColor: "#111827",
    paddingBottom: 12
  },
  headline: {
    fontSize: 26,
    fontWeight: "bold",
    marginBottom: 2
  },
  baseUrl: {
    fontSize: 11,
    color: "#4b5563",
    marginBottom: 8
  },
  headerMetaRow: {
    flexDirection: "row"
  },
  headerMetaItem: {
    fontSize: 9,
    color: "#6b7280",
    marginRight: 16
  },
  scoreRow: {
    flexDirection: "row",
    marginBottom: 20
  },
  scoreCard: {
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 6,
    paddingVertical: 16,
    paddingHorizontal: 24,
    marginRight: 16,
    minWidth: 140
  },
  scoreValue: {
    fontSize: 36,
    fontWeight: "bold"
  },
  scoreOutOf: {
    fontSize: 9,
    color: "#9ca3af",
    marginTop: -2,
    marginBottom: 4
  },
  scoreLabel: {
    fontSize: 10,
    color: "#374151",
    fontWeight: "bold"
  },
  severityRollup: {
    flexDirection: "row",
    marginBottom: 24,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    paddingVertical: 10
  },
  severityRollupItem: {
    flexDirection: "column",
    alignItems: "center",
    marginRight: 32
  },
  severityRollupCount: {
    fontSize: 18,
    fontWeight: "bold"
  },
  severityRollupLabel: {
    fontSize: 9,
    color: "#6b7280",
    marginTop: 2
  },
  section: {
    marginBottom: 18
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "bold",
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#d1d5db"
  },
  emptyState: {
    paddingVertical: 14,
    paddingHorizontal: 12,
    backgroundColor: "#f3f4f6",
    borderRadius: 4
  },
  emptyStateText: {
    fontSize: 10,
    color: "#4b5563"
  },
  findingCard: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 4,
    padding: 10,
    marginBottom: 8
  },
  findingHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4
  },
  severityBadge: {
    borderRadius: 3,
    paddingVertical: 2,
    paddingHorizontal: 6,
    marginRight: 8
  },
  severityBadgeText: {
    fontSize: 8,
    fontWeight: "bold"
  },
  findingTitle: {
    fontSize: 11,
    fontWeight: "bold",
    flex: 1
  },
  findingMessage: {
    fontSize: 9.5,
    color: "#1f2937",
    marginBottom: 4,
    lineHeight: 1.35
  },
  findingPage: {
    fontSize: 8.5,
    color: "#2563eb",
    marginBottom: 4
  },
  findingEvidence: {
    fontSize: 8,
    fontFamily: "Courier",
    color: "#6b7280",
    backgroundColor: "#f9fafb",
    padding: 6,
    borderRadius: 3
  },
  table: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 4
  },
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: "#111827",
    paddingVertical: 6,
    paddingHorizontal: 6
  },
  tableHeaderText: {
    color: "#ffffff",
    fontWeight: "bold",
    fontSize: 8.5
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb"
  },
  tableRowAlt: {
    backgroundColor: "#f9fafb"
  },
  tableCell: {
    fontSize: 8.5,
    paddingRight: 4
  },
  colUrl: {
    width: "42%"
  },
  colStatus: {
    width: "12%"
  },
  colTitle: {
    width: "31%"
  },
  colWordCount: {
    width: "15%",
    textAlign: "right"
  },
  wordBreakAll: {
    wordBreak: "break-all"
  },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 40,
    right: 40,
    fontSize: 8,
    color: "#9ca3af",
    textAlign: "center"
  }
});
