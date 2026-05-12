// lib/sync/prod-to-test/phases/types.ts
import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EntityName, WatermarkMap } from "@/lib/sync/prod-to-test/watermarks";

export interface CliFlags {
  phase: EntityName | null;
  limitPerPhase: number | null;
  noBackup: boolean;
  iKnowWhatImDoing: boolean;
}

export interface PhaseCtx {
  prod: Pool;
  test: Pool;
  prodStorage: SupabaseClient;
  testStorage: SupabaseClient;
  watermarks: WatermarkMap;
  flags: CliFlags;
  log: (msg: string) => void;
}

export interface PhaseError {
  prodId: string;
  reason: string;
}

export interface PhaseResult {
  entity: EntityName;
  scanned: number;
  inserted: number;
  skipped: number;
  failed: number;
  newWatermark: Date;
  errors: PhaseError[];
}

export type RunPhase = (ctx: PhaseCtx) => Promise<PhaseResult>;
