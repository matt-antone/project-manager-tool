// lib/imports/audit/types.ts

export type EntityKind = "people" | "projects" | "topics" | "comments" | "files";

type EntityStatus =
  | "mapped"
  | "skipped_unsupported"
  | "skipped_existing"
  | "failed"
  | "missing";

export interface PeopleExpected {
  bc2Id: number;
  email: string;
  name: string;
}

export interface ProjectExpected {
  bc2Id: number;
  name: string;
  archived: boolean;
}

export interface TopicExpected {
  bc2ProjectId: number;
  bc2TopicId: number;
  topicableType: string;
  title: string;
}

export interface CommentExpected {
  bc2ProjectId: number;
  bc2TopicId: number;
  bc2CommentId: number;
}

export interface FileExpected {
  bc2ProjectId: number;
  bc2AttachmentId: number;
  filename: string;
  byteSize: number | null;
}

export interface DbState {
  // basecamp_*_id -> local_*_id
  peopleMap: Map<string, string>;
  projectsMap: Map<string, string>;
  threadsMap: Map<string, string>;
  commentsMap: Map<string, string>;
  filesMap: Map<string, string>;
  // (record_type, source_record_id) -> { status, message }
  logs: Map<string, { status: string; message: string | null }>;
}

export interface ClassifiedRow {
  status: EntityStatus;
  localId: string;
  reason: string;
}

export interface SummaryCounts {
  expected: number;
  mapped: number;
  accountedSkip: number;
  accountedFail: number;
  unaccounted: number;
}

export type SummaryByEntity = Record<EntityKind, SummaryCounts>;
