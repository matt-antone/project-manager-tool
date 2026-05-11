// lib/imports/orphans/apply.ts
//
// Per-row applier for orphan decisions.
//
// NOTE: the insert into `projects` (13 columns: name, slug, description,
// client_id, archived, created_by, project_seq, project_code, client_slug,
// project_slug, storage_project_dir, created_at, updated_at) duplicates the
// shape used by lib/imports/migration/projects.ts. Both insert sites must be
// updated together if the projects table changes. See the orphan-recon spec
// for why we do not refactor migrateProjects (memory rule: phase modules are
// off-limits).

import { sanitizeDropboxFolderTitle } from "@/lib/project-storage";
import { logRecord, type Query } from "@/lib/imports/migration/jobs";
import {
  ClientNotFoundError,
  type ApplyOutcome,
  type OrphanDecision,
} from "./types";

export interface DumpProjectShape {
  bc2Id: number;
  title: string;
  archived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  description: string | null;
}

function dropboxProjectsRoot(): string {
  return (
    process.env.DROPBOX_PROJECTS_ROOT_FOLDER?.trim() ||
    process.env.DROPBOX_ROOT_FOLDER?.trim() ||
    "/Projects"
  );
}

function slugify(s: string): string {
  return (
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project"
  );
}

function parseIso(v: string | null | undefined): Date {
  if (!v) return new Date();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

async function lookupClient(q: Query, code: string): Promise<string | null> {
  const r = await q<{ id: string }>(
    "select id from clients where lower(code) = lower($1) limit 1",
    [code],
  );
  return r.rows[0]?.id ?? null;
}

async function createClient(q: Query, code: string, name: string): Promise<string> {
  const r = await q<{ id: string }>(
    "insert into clients (name, code) values ($1, $2) returning id",
    [name, code],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`clients insert returned no id`);
  return id;
}

async function existingMapping(
  q: Query,
  bc2Id: string,
): Promise<string | null> {
  const r = await q<{ local_project_id: string }>(
    "select local_project_id from import_map_projects where basecamp_project_id = $1",
    [bc2Id],
  );
  return r.rows[0]?.local_project_id ?? null;
}

async function insertProjectAndMap(args: {
  q: Query;
  clientId: string;
  clientCode: string;
  decision: OrphanDecision;
  dumpProject: DumpProjectShape;
}): Promise<string> {
  const { q, clientId, clientCode, decision, dumpProject } = args;
  const title = decision.title || `bc2-${dumpProject.bc2Id}`;

  const seqRow = await q<{ next_seq: number }>(
    "select coalesce(max(project_seq), 0) + 1 as next_seq from projects where client_id is not distinct from $1",
    [clientId],
  );
  const projectSeq = seqRow.rows[0]?.next_seq ?? null;

  const clientSlug = slugify(clientCode);
  const projectSlug = title ? slugify(title) : null;
  // No `num` for orphan rows — operator-supplied code does not carry a numeric
  // suffix — so project_code stays null and the storage folder uses _NoCode_.
  const folderName = `_NoCode_${dumpProject.bc2Id}-${sanitizeDropboxFolderTitle(title)}`;
  const projectsRoot = dropboxProjectsRoot();
  const storageDir = dumpProject.archived
    ? `${projectsRoot}/${clientCode}/_Archive/${folderName}`
    : `${projectsRoot}/${clientCode}/${folderName}`;
  const urlSlug = `${slugify(title)}-bc2-${dumpProject.bc2Id}`;

  const createdAt = parseIso(dumpProject.createdAt);
  const updatedAt = parseIso(dumpProject.updatedAt ?? dumpProject.createdAt);

  const proj = await q<{ id: string }>(
    `insert into projects
       (name, slug, description, client_id, archived, created_by,
        project_seq, project_code, client_slug, project_slug, storage_project_dir,
        created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id`,
    [
      title,
      urlSlug,
      dumpProject.description ?? null,
      clientId,
      dumpProject.archived,
      "bc2_import",
      projectSeq,
      null, // project_code is null for orphans
      clientSlug,
      projectSlug,
      storageDir,
      createdAt,
      updatedAt,
    ],
  );
  const localId = proj.rows[0]?.id;
  if (!localId) throw new Error(`projects insert returned no id`);

  await q(
    "insert into import_map_projects (basecamp_project_id, local_project_id) values ($1, $2)",
    [decision.bc2Id, localId],
  );

  return localId;
}

export async function applyDecision(args: {
  q: Query;
  decision: OrphanDecision;
  dumpProject: DumpProjectShape;
  jobId: string;
}): Promise<ApplyOutcome> {
  const { q, decision, dumpProject, jobId } = args;

  // Idempotency precheck takes precedence over every action including `skip`:
  // an already-mapped project does not get a duplicate skip log, since the
  // mapping itself is the canonical record of resolution.
  const existing = await existingMapping(q, decision.bc2Id);
  if (existing) {
    return { status: "already_mapped", localProjectId: existing };
  }

  if (decision.action === "skip") {
    await logRecord(q, {
      jobId,
      recordType: "project",
      sourceId: decision.bc2Id,
      status: "success",
      message: `orphan_skipped: ${decision.title}`,
      dataSource: "api",
    });
    return { status: "skipped" };
  }

  if (decision.action === "assign") {
    const clientId = await lookupClient(q, decision.code);
    if (!clientId) throw new ClientNotFoundError(decision.code);
    const localId = await insertProjectAndMap({
      q,
      clientId,
      clientCode: decision.code,
      decision,
      dumpProject,
    });
    return { status: "assigned", localProjectId: localId, clientId };
  }

  if (decision.action === "create") {
    let clientId = await lookupClient(q, decision.code);
    if (!clientId) {
      clientId = await createClient(q, decision.code, decision.clientName);
    }
    const localId = await insertProjectAndMap({
      q,
      clientId,
      clientCode: decision.code,
      decision,
      dumpProject,
    });
    return { status: "created", localProjectId: localId, clientId };
  }

  // Unreachable: validateRow rejects empty/unknown actions.
  throw new Error(`applyDecision called with unhandled action='${decision.action}'`);
}
