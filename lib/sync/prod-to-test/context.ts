import { Pool } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadWatermarks } from "./watermarks";
import type { PhaseCtx, CliFlags } from "./phases/types";

export interface BuildContextInput {
  prodUrl: string;
  testUrl: string;
  prodSupabaseUrl: string;
  prodServiceRoleKey: string;
  testSupabaseUrl: string;
  testServiceRoleKey: string;
  flags: CliFlags;
  log: (msg: string) => void;
}

export async function buildContext(input: BuildContextInput): Promise<PhaseCtx> {
  const prod = new Pool({ connectionString: input.prodUrl, max: 4 });
  const test = new Pool({ connectionString: input.testUrl, max: 4 });
  const prodStorage = createClient(input.prodSupabaseUrl, input.prodServiceRoleKey, {
    auth: { persistSession: false },
  });
  const testStorage = createClient(input.testSupabaseUrl, input.testServiceRoleKey, {
    auth: { persistSession: false },
  });
  const watermarks = await loadWatermarks(test);
  return {
    prod,
    test,
    prodStorage: prodStorage as SupabaseClient,
    testStorage: testStorage as SupabaseClient,
    watermarks,
    flags: input.flags,
    log: input.log,
  };
}
