// lib/imports/audit/reader.ts
import { promises as fs } from "fs";
import * as path from "path";
import type {
  PeopleExpected,
  ProjectExpected,
  TopicExpected,
  CommentExpected,
  FileExpected,
} from "./types";

const TOPICABLE_TYPE_TO_SEGMENT: Record<string, string> = {
  Message: "messages",
  Todolist: "todolists",
  CalendarEvent: "calendar_events",
  Calendar: "calendar_events",
  Upload: "uploads",
  Document: "documents",
};

async function readJson<T>(p: string): Promise<T | null> {
  try {
    const buf = await fs.readFile(p, "utf8");
    if (buf.trim().length === 0) return null;
    return JSON.parse(buf) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

interface RawPerson {
  id: number;
  email_address?: string;
  name?: string;
}

interface RawProject {
  id: number;
  name?: string;
  archived?: boolean;
}

interface RawTopicSummary {
  id: number;
  title?: string;
  topicable: { id: number; type: string };
}

interface RawComment {
  id: number;
}

interface RawAttachment {
  id: number;
  name?: string;
  byte_size?: number;
}

interface RawTopicDetail {
  comments?: RawComment[];
}

export async function readPeople(dumpDir: string): Promise<PeopleExpected[]> {
  const data = (await readJson<RawPerson[]>(path.join(dumpDir, "people.json"))) ?? [];
  return data.map((p) => ({ bc2Id: p.id, email: p.email_address ?? "", name: p.name ?? "" }));
}

export async function readProjects(dumpDir: string): Promise<ProjectExpected[]> {
  const active = (await readJson<RawProject[]>(path.join(dumpDir, "projects", "active.json"))) ?? [];
  const archived = (await readJson<RawProject[]>(path.join(dumpDir, "projects", "archived.json"))) ?? [];
  return [
    ...active.map((p) => ({ bc2Id: p.id, name: p.name ?? "", archived: !!p.archived })),
    ...archived.map((p) => ({ bc2Id: p.id, name: p.name ?? "", archived: true })),
  ];
}

export async function listProjectIds(dumpDir: string): Promise<number[]> {
  const root = path.join(dumpDir, "by-project");
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .map((e) => Number.parseInt(e, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

export async function readTopicsForProject(
  dumpDir: string,
  projectId: number,
): Promise<TopicExpected[]> {
  const data = (await readJson<RawTopicSummary[]>(
    path.join(dumpDir, "by-project", String(projectId), "topics.json"),
  )) ?? [];
  return data.map((t) => ({
    bc2ProjectId: projectId,
    bc2TopicId: t.topicable?.id ?? t.id,
    topicableType: t.topicable?.type ?? "",
    title: t.title ?? "",
  }));
}

export async function readCommentsForTopic(
  dumpDir: string,
  projectId: number,
  topicableType: string,
  topicId: number,
): Promise<CommentExpected[]> {
  const segment = TOPICABLE_TYPE_TO_SEGMENT[topicableType];
  if (!segment) return [];
  const data = (await readJson<RawTopicDetail>(
    path.join(dumpDir, "by-project", String(projectId), segment, `${topicId}.json`),
  )) ?? {};
  return (data.comments ?? []).map((c) => ({
    bc2ProjectId: projectId,
    bc2TopicId: topicId,
    bc2CommentId: c.id,
  }));
}

export interface CommentDetail {
  id: number;
  content?: string;
  creator?: { id: number; name?: string };
  created_at?: string;
}

export async function readCommentDetailsForTopic(
  dumpDir: string,
  projectId: number,
  topicableType: string,
  topicId: number,
): Promise<CommentDetail[]> {
  const segment = TOPICABLE_TYPE_TO_SEGMENT[topicableType];
  if (!segment) return [];
  const data = (await readJson<{ comments?: CommentDetail[] }>(
    path.join(dumpDir, "by-project", String(projectId), segment, `${topicId}.json`),
  )) ?? {};
  return data.comments ?? [];
}

export async function readAttachmentsForProject(
  dumpDir: string,
  projectId: number,
): Promise<FileExpected[]> {
  const data = (await readJson<RawAttachment[]>(
    path.join(dumpDir, "by-project", String(projectId), "attachments.json"),
  )) ?? [];
  return data.map((a) => ({
    bc2ProjectId: projectId,
    bc2AttachmentId: a.id,
    filename: a.name ?? "",
    byteSize: a.byte_size ?? null,
  }));
}
