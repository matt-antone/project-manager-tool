/**
 * Ambient module declaration for the untyped upstream audit engine.
 * The real package ships as plain JS with no bundled types, so without this
 * declaration `runApiAudit` resolves to `any` and every call site loses type
 * safety on both input and the returned `AuditResult`.
 */
declare module "@matt-antone/seo-audit/src/audit-api.js" {
  import type { AuditResult } from "@/lib/types/seo-audit";

  export type RunApiAuditOptions = {
    url: string;
    maxPages?: number;
    concurrency?: number;
    checksFilter?: string[];
  };

  export function runApiAudit(options: RunApiAuditOptions): Promise<AuditResult>;
}
