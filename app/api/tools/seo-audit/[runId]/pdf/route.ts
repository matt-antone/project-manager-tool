import { requireUser } from "@/lib/auth";
import { conflict, notFound, serverError, unauthorized } from "@/lib/http";
import { getSeoAuditRunForUser } from "@/lib/seo-audit-repository";
import { AuditPdfDocument } from "@/components/tools/seo-audit/audit-pdf-document";
import { renderToBuffer } from "@react-pdf/renderer";
import { z } from "zod";

// react-pdf relies on Node APIs and will not run on the edge runtime.
export const runtime = "nodejs";

const runIdSchema = z.string().uuid();

function sanitizeHostForFilename(host: string): string {
  const cleaned = host.trim().toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  return cleaned || "site";
}

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  let runId: string | undefined;
  try {
    const user = await requireUser(request);
    const { runId: rawRunId } = await params;
    const parsedRunId = runIdSchema.safeParse(rawRunId);
    if (!parsedRunId.success) {
      return notFound("SEO audit run not found");
    }
    runId = parsedRunId.data;

    const run = await getSeoAuditRunForUser(runId, user.id);
    if (!run) {
      return notFound("SEO audit run not found");
    }
    if (run.status !== "succeeded" || !run.result) {
      return conflict("SEO audit run has not succeeded yet");
    }

    const buffer = await renderToBuffer(AuditPdfDocument({ result: run.result }));

    const host = sanitizeHostForFilename(run.host ?? run.result.site.host);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `seo-audit-${host}-${date}.pdf`;

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`
      }
    });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    console.error("seo_audit_pdf_failed", {
      runId,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverError();
  }
}
