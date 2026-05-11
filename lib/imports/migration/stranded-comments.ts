import { parseBc2IsoTimestamptz } from "../bc2-fetcher";
import { readTopicsForProject, readCommentDetailsForTopic } from "../audit/reader";
import { logRecord, type Query } from "./jobs";

const SUPPORTED_TOPICS = new Set(["Message", "Todolist", "Upload", "Document"]);

export interface ReconStrandedCommentsDeps {
  q: Query;
  jobId: string;
  dumpDir: string;
  projectIds: number[];
  personMap: Map<number, string>;
  createComment: (args: {
    projectId: string;
    threadId: string;
    bodyMarkdown: string;
    authorUserId: string;
    sourceCreatedAt?: Date;
  }) => Promise<{ id: string }>;
}

export interface PerProject {
  bc2Id: number;
  localId: string | null;
  success: number;
  failed: number;
  skipped: {
    already_mapped: number;
    orphan_no_thread: number;
    unsupported_topicable: number;
  };
}

export interface ReconResult {
  perProject: PerProject[];
  totals: {
    success: number;
    failed: number;
    skipped_already_mapped: number;
    skipped_orphan_no_thread: number;
    skipped_unsupported_topicable: number;
    projects_skipped_unmapped: number;
  };
}

export async function reconStrandedComments(deps: ReconStrandedCommentsDeps): Promise<ReconResult> {
  const { q, jobId, dumpDir, projectIds, personMap, createComment } = deps;

  const perProject: PerProject[] = [];
  let projects_skipped_unmapped = 0;

  for (const bc2Id of projectIds) {
    const projRes = await q<{ local_project_id: string }>(
      "select local_project_id from import_map_projects where basecamp_project_id = $1",
      [String(bc2Id)],
    );
    const localId = projRes.rows[0]?.local_project_id ?? null;
    if (!localId) {
      projects_skipped_unmapped++;
      perProject.push({
        bc2Id,
        localId: null,
        success: 0,
        failed: 0,
        skipped: { already_mapped: 0, orphan_no_thread: 0, unsupported_topicable: 0 },
      });
      continue;
    }

    const summary: PerProject = {
      bc2Id,
      localId,
      success: 0,
      failed: 0,
      skipped: { already_mapped: 0, orphan_no_thread: 0, unsupported_topicable: 0 },
    };

    const topics = await readTopicsForProject(dumpDir, bc2Id);
    for (const topic of topics) {
      if (!SUPPORTED_TOPICS.has(topic.topicableType)) {
        summary.skipped.unsupported_topicable++;
        continue;
      }

      const threadRes = await q<{ local_thread_id: string }>(
        "select local_thread_id from import_map_threads where basecamp_thread_id = $1",
        [String(topic.bc2TopicId)],
      );
      const threadLocalId = threadRes.rows[0]?.local_thread_id ?? null;

      const comments = await readCommentDetailsForTopic(
        dumpDir,
        bc2Id,
        topic.topicableType,
        topic.bc2TopicId,
      );

      const sorted = [...comments].sort((a, b) => {
        const ta = a.created_at ?? "";
        const tb = b.created_at ?? "";
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });

      for (const cmt of sorted) {
        const mapRes = await q<{ local_comment_id: string }>(
          "select local_comment_id from import_map_comments where basecamp_comment_id = $1",
          [String(cmt.id)],
        );
        if (mapRes.rows[0]) {
          summary.skipped.already_mapped++;
          continue;
        }

        if (!threadLocalId) {
          await logRecord(q, {
            jobId,
            recordType: "comment",
            sourceId: String(cmt.id),
            status: "failed",
            message: "orphan_no_thread",
            dataSource: "dump",
          });
          summary.skipped.orphan_no_thread++;
          continue;
        }

        const creatorId = cmt.creator?.id;
        const authorUserId = (creatorId != null ? personMap.get(creatorId) : undefined)
          ?? `dry_${creatorId ?? "unknown"}`;

        try {
          const created = await createComment({
            projectId: localId,
            threadId: threadLocalId,
            bodyMarkdown: cmt.content ?? "",
            authorUserId,
            sourceCreatedAt: parseBc2IsoTimestamptz(cmt.created_at) ?? undefined,
          });
          try {
            await q(
              "insert into import_map_comments (basecamp_comment_id, local_comment_id) values ($1, $2)",
              [String(cmt.id), created.id],
            );
          } catch (mapErr) {
            const code = (mapErr as { code?: string }).code;
            if (code === "23505") {
              summary.skipped.already_mapped++;
              continue;
            }
            throw mapErr;
          }
          await logRecord(q, {
            jobId, recordType: "comment", sourceId: String(cmt.id),
            status: "success", dataSource: "dump",
          });
          summary.success++;
        } catch (err) {
          await logRecord(q, {
            jobId, recordType: "comment", sourceId: String(cmt.id),
            status: "failed",
            message: err instanceof Error ? err.message : String(err),
            dataSource: "dump",
          });
          summary.failed++;
        }
      }
    }

    perProject.push(summary);
  }

  const totals = {
    success: perProject.reduce((s, p) => s + p.success, 0),
    failed: perProject.reduce((s, p) => s + p.failed, 0),
    skipped_already_mapped: perProject.reduce((s, p) => s + p.skipped.already_mapped, 0),
    skipped_orphan_no_thread: perProject.reduce((s, p) => s + p.skipped.orphan_no_thread, 0),
    skipped_unsupported_topicable: perProject.reduce((s, p) => s + p.skipped.unsupported_topicable, 0),
    projects_skipped_unmapped,
  };
  return { perProject, totals };
}
