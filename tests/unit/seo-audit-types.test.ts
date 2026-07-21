import { describe, expect, it } from "vitest";
import {
  countBySeverity,
  severityRank,
  type AuditFinding,
  type AuditSeverity
} from "@/lib/types/seo-audit";

function finding(severity: AuditSeverity): AuditFinding {
  return {
    check: `check-${severity}`,
    severity,
    category: "seo",
    title: "Title",
    page: null,
    message: "Message",
    evidence: null,
    verifiedBy: "http"
  };
}

describe("countBySeverity", () => {
  it("counts findings per severity", () => {
    const findings = [
      finding("critical"),
      finding("critical"),
      finding("high"),
      finding("medium"),
      finding("medium"),
      finding("medium"),
      finding("low")
    ];

    expect(countBySeverity(findings)).toEqual({
      critical: 2,
      high: 1,
      medium: 3,
      low: 1
    });
  });

  it("returns all zeros for an empty array", () => {
    expect(countBySeverity([])).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    });
  });

  it("ignores findings with an unknown severity value without crashing", () => {
    const findings = [
      finding("high"),
      // Simulates a payload from a newer/older version of the upstream
      // package that introduces a severity value this build doesn't know
      // about yet.
      { ...finding("high"), severity: "info" as unknown as AuditSeverity }
    ];

    expect(countBySeverity(findings)).toEqual({
      critical: 0,
      high: 1,
      medium: 0,
      low: 0
    });
  });
});

describe("severityRank", () => {
  it("ranks critical > high > medium > low, worst first", () => {
    expect(severityRank("critical")).toBe(0);
    expect(severityRank("high")).toBe(1);
    expect(severityRank("medium")).toBe(2);
    expect(severityRank("low")).toBe(3);
  });

  it("sorts unknown severities to the end", () => {
    expect(severityRank("info" as unknown as AuditSeverity)).toBe(4);
  });

  it("produces a worst-first ordering when used as a sort comparator", () => {
    const findings = [
      finding("low"),
      finding("critical"),
      finding("medium"),
      finding("high"),
      finding("critical"),
      finding("low")
    ];

    const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

    expect(sorted.map((f) => f.severity)).toEqual([
      "critical",
      "critical",
      "high",
      "medium",
      "low",
      "low"
    ]);
  });

  it("keeps unknown-severity findings at the end of a real sort", () => {
    const findings: AuditFinding[] = [
      finding("low"),
      { ...finding("low"), severity: "info" as unknown as AuditSeverity },
      finding("critical")
    ];

    const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

    expect(sorted.map((f) => f.severity)).toEqual(["critical", "low", "info"]);
  });
});
