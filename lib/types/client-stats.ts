// lib/types/client-stats.ts
import type { ClientRecord } from "@/lib/types/client-record";

export type ClientWithStats = ClientRecord & {
  active_project_count: number;
  last_activity_at: string | null;
};

export type ClientDetailStats = {
  activeProjectCount: number;
  archivedProjectCount: number;
  lastActivityAt: string | null;
};

export type ClientProjectRow = {
  id: string;
  name: string;
  status: string | null;
  last_activity_at: string | null;
  deadline: string | null;
  created_at: string;
};

export type ClientTabCounts = { active: number; archived: number };
