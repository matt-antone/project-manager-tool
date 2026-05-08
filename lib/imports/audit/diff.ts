// lib/imports/audit/diff.ts
import type { ClassifiedRow, DbState, EntityKind } from "./types";

export type Query = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>;

const KIND_TO_RECORD_TYPE: Record<EntityKind, string> = {
  people: "person",
  projects: "project",
  topics: "thread",
  comments: "comment",
  files: "file",
};

const KIND_TO_MAP: Record<EntityKind, keyof DbState> = {
  people: "peopleMap",
  projects: "projectsMap",
  topics: "threadsMap",
  comments: "commentsMap",
  files: "filesMap",
};

export function classifyEntity(args: {
  kind: EntityKind;
  bc2Id: string;
  state: DbState;
}): ClassifiedRow {
  const { kind, bc2Id, state } = args;
  const map = state[KIND_TO_MAP[kind]] as Map<string, string>;
  const mapped = map.get(bc2Id);
  if (mapped) {
    return { status: "mapped", localId: mapped, reason: "" };
  }
  const recordType = KIND_TO_RECORD_TYPE[kind];
  const log = state.logs.get(`${recordType}:${bc2Id}`);
  if (log) {
    const msg = log.message ?? "";
    if (msg.startsWith("skipped_topicable_type=")) {
      return { status: "skipped_unsupported", localId: "", reason: msg };
    }
    if (msg === "skipped_existing") {
      return { status: "skipped_existing", localId: "", reason: msg };
    }
    if (log.status === "failed") {
      return { status: "failed", localId: "", reason: msg };
    }
    // Successful log without a corresponding map entry — treat as missing.
    return { status: "missing", localId: "", reason: msg };
  }
  return { status: "missing", localId: "", reason: "" };
}

export async function loadDbState(q: Query): Promise<DbState> {
  const peopleMap = new Map<string, string>();
  const projectsMap = new Map<string, string>();
  const threadsMap = new Map<string, string>();
  const commentsMap = new Map<string, string>();
  const filesMap = new Map<string, string>();
  const logs = new Map<string, { status: string; message: string | null }>();

  const peopleRows = (
    await q<{ basecamp_person_id: string; local_user_profile_id: string }>(
      "select basecamp_person_id, local_user_profile_id from import_map_people",
    )
  ).rows;
  for (const r of peopleRows) peopleMap.set(r.basecamp_person_id, r.local_user_profile_id);

  const projectRows = (
    await q<{ basecamp_project_id: string; local_project_id: string }>(
      "select basecamp_project_id, local_project_id from import_map_projects",
    )
  ).rows;
  for (const r of projectRows) projectsMap.set(r.basecamp_project_id, r.local_project_id);

  const threadRows = (
    await q<{ basecamp_thread_id: string; local_thread_id: string }>(
      "select basecamp_thread_id, local_thread_id from import_map_threads",
    )
  ).rows;
  for (const r of threadRows) threadsMap.set(r.basecamp_thread_id, r.local_thread_id);

  const commentRows = (
    await q<{ basecamp_comment_id: string; local_comment_id: string }>(
      "select basecamp_comment_id, local_comment_id from import_map_comments",
    )
  ).rows;
  for (const r of commentRows) commentsMap.set(r.basecamp_comment_id, r.local_comment_id);

  const fileRows = (
    await q<{ basecamp_file_id: string; local_file_id: string }>(
      "select basecamp_file_id, local_file_id from import_map_files",
    )
  ).rows;
  for (const r of fileRows) filesMap.set(r.basecamp_file_id, r.local_file_id);

  // logs: latest status+message per (record_type, source_record_id).
  const logRows = (
    await q<{
      record_type: string;
      source_record_id: string;
      status: string;
      message: string | null;
    }>(
      `select distinct on (record_type, source_record_id)
         record_type, source_record_id, status, message
       from import_logs
       order by record_type, source_record_id, created_at desc`,
    )
  ).rows;
  for (const r of logRows) {
    logs.set(`${r.record_type}:${r.source_record_id}`, {
      status: r.status,
      message: r.message,
    });
  }

  return { peopleMap, projectsMap, threadsMap, commentsMap, filesMap, logs };
}
