import { query } from "../db";
import { createComment, createFileMetadata, createProject, createThread, getProject } from "../repositories";

type BasecampFile = {
  id: string;
  projectId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  dropboxFileId: string;
  dropboxPath: string;
  uploaderUserId: string;
};

type BasecampComment = {
  id: string;
  threadId: string;
  projectId: string;
  body: string;
  authorUserId: string;
};

type BasecampThread = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  authorUserId: string;
};

type BasecampProject = {
  id: string;
  name: string;
  description?: string;
  archived?: boolean;
  createdBy: string;
};

export type BasecampImportPayload = {
  projects?: BasecampProject[];
  threads?: BasecampThread[];
  comments?: BasecampComment[];
  files?: BasecampFile[];
};

export async function createImportJob(options: unknown) {
  const result = await query(
    `insert into import_jobs (status, options)
     values ('running', $1)
     returning *`,
    [JSON.stringify(options ?? {})]
  );
  return result.rows[0];
}

export async function getImportJob(jobId: string) {
  const job = await query("select * from import_jobs where id = $1", [jobId]);
  const logs = await query(
    "select * from import_logs where job_id = $1 order by created_at desc limit 200",
    [jobId]
  );
  return {
    job: job.rows[0] ?? null,
    logs: logs.rows
  };
}

async function appendLog(args: {
  jobId: string;
  recordType: string;
  sourceRecordId: string;
  status: "success" | "failed";
  message?: string;
}) {
  await query(
    `insert into import_logs (job_id, record_type, source_record_id, status, message)
     values ($1, $2, $3, $4, $5)`,
    [args.jobId, args.recordType, args.sourceRecordId, args.status, args.message ?? null]
  );
}

async function updateJobCounters(jobId: string, successDelta: number, failedDelta: number) {
  await query(
    `update import_jobs
     set success_count = success_count + $2,
         failed_count = failed_count + $3,
         total_records = total_records + $2 + $3
     where id = $1`,
    [jobId, successDelta, failedDelta]
  );
}

async function setJobFinished(jobId: string, status: "completed" | "failed") {
  await query(
    "update import_jobs set status = $2, finished_at = now() where id = $1",
    [jobId, status]
  );
}

export async function runBasecampImport(jobId: string, payload: BasecampImportPayload) {
  try {
    for (const project of payload.projects ?? []) {
      const existingMap = await query(
        "select local_project_id from import_map_projects where basecamp_project_id = $1",
        [project.id]
      );
      if (existingMap.rows[0]) {
        await appendLog({
          jobId,
          recordType: "project",
          sourceRecordId: project.id,
          status: "success",
          message: "Already mapped"
        });
        await updateJobCounters(jobId, 1, 0);
        continue;
      }

      const { project: created } = await createProject({
        name: project.name,
        description: project.description,
        createdBy: project.createdBy
      });

      if (project.archived) {
        await query("update projects set archived = true where id = $1", [created.id]);
      }

      await query(
        "insert into import_map_projects (basecamp_project_id, local_project_id) values ($1, $2)",
        [project.id, created.id]
      );
      await appendLog({ jobId, recordType: "project", sourceRecordId: project.id, status: "success" });
      await updateJobCounters(jobId, 1, 0);
    }

    for (const thread of payload.threads ?? []) {
      const existingMap = await query(
        "select local_thread_id from import_map_threads where basecamp_thread_id = $1",
        [thread.id]
      );
      if (existingMap.rows[0]) {
        await appendLog({
          jobId,
          recordType: "thread",
          sourceRecordId: thread.id,
          status: "success",
          message: "Already mapped"
        });
        await updateJobCounters(jobId, 1, 0);
        continue;
      }

      const mappedProject = await query(
        "select local_project_id from import_map_projects where basecamp_project_id = $1",
        [thread.projectId]
      );
      const projectId = mappedProject.rows[0]?.local_project_id;
      if (!projectId || !(await getProject(projectId))) {
        throw new Error(`Thread ${thread.id} references unknown project ${thread.projectId}`);
      }

      const created = await createThread({
        projectId,
        title: thread.title,
        bodyMarkdown: thread.body,
        authorUserId: thread.authorUserId
      });

      await query(
        "insert into import_map_threads (basecamp_thread_id, local_thread_id) values ($1, $2)",
        [thread.id, created.id]
      );
      await appendLog({ jobId, recordType: "thread", sourceRecordId: thread.id, status: "success" });
      await updateJobCounters(jobId, 1, 0);
    }

    for (const comment of payload.comments ?? []) {
      const existingMap = await query(
        "select local_comment_id from import_map_comments where basecamp_comment_id = $1",
        [comment.id]
      );
      if (existingMap.rows[0]) {
        await appendLog({
          jobId,
          recordType: "comment",
          sourceRecordId: comment.id,
          status: "success",
          message: "Already mapped"
        });
        await updateJobCounters(jobId, 1, 0);
        continue;
      }

      const mappedProject = await query(
        "select local_project_id from import_map_projects where basecamp_project_id = $1",
        [comment.projectId]
      );
      const mappedThread = await query(
        "select local_thread_id from import_map_threads where basecamp_thread_id = $1",
        [comment.threadId]
      );
      const projectId = mappedProject.rows[0]?.local_project_id;
      const threadId = mappedThread.rows[0]?.local_thread_id;
      if (!projectId || !threadId) {
        throw new Error(`Comment ${comment.id} references unknown relations`);
      }

      const created = await createComment({
        projectId,
        threadId,
        bodyMarkdown: comment.body,
        authorUserId: comment.authorUserId
      });

      await query(
        "insert into import_map_comments (basecamp_comment_id, local_comment_id) values ($1, $2)",
        [comment.id, created.id]
      );
      await appendLog({ jobId, recordType: "comment", sourceRecordId: comment.id, status: "success" });
      await updateJobCounters(jobId, 1, 0);
    }

    for (const file of payload.files ?? []) {
      const existingMap = await query(
        "select local_file_id from import_map_files where basecamp_file_id = $1",
        [file.id]
      );
      if (existingMap.rows[0]) {
        await appendLog({
          jobId,
          recordType: "file",
          sourceRecordId: file.id,
          status: "success",
          message: "Already mapped"
        });
        await updateJobCounters(jobId, 1, 0);
        continue;
      }

      const mappedProject = await query(
        "select local_project_id from import_map_projects where basecamp_project_id = $1",
        [file.projectId]
      );
      const projectId = mappedProject.rows[0]?.local_project_id;
      if (!projectId) {
        throw new Error(`File ${file.id} references unknown project ${file.projectId}`);
      }

      const existingFile = await query(
        "select * from project_files where project_id = $1 and dropbox_file_id = $2 limit 1",
        [projectId, file.dropboxFileId]
      );

      const fileRecord =
        existingFile.rows[0] ??
        (await createFileMetadata({
          projectId,
          uploaderUserId: file.uploaderUserId,
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          checksum: file.checksum,
          dropboxFileId: file.dropboxFileId,
          dropboxPath: file.dropboxPath,
        }));

      await query(
        "insert into import_map_files (basecamp_file_id, local_file_id) values ($1, $2)",
        [file.id, fileRecord.id]
      );
      await appendLog({ jobId, recordType: "file", sourceRecordId: file.id, status: "success" });
      await updateJobCounters(jobId, 1, 0);
    }

    await setJobFinished(jobId, "completed");
  } catch (error) {
    await appendLog({
      jobId,
      recordType: "job",
      sourceRecordId: jobId,
      status: "failed",
      message: error instanceof Error ? error.message : String(error)
    });
    await updateJobCounters(jobId, 0, 1);
    await setJobFinished(jobId, "failed");
  }
}

export async function retryFailedImport(jobId: string) {
  const failed = await query(
    "select record_type, source_record_id from import_logs where job_id = $1 and status = 'failed' order by created_at asc",
    [jobId]
  );
  return {
    retried: failed.rows.length,
    records: failed.rows
  };
}
