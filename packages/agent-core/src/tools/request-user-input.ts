import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentRequest } from '@loob/db';
import { insertAgentRequest } from '@loob/db';
import type { Result } from '@loob/shared';
import { ok, err } from '@loob/shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any>;

export interface RequestUserInputParams {
  kind: AgentRequest['kind'];
  prompt: string;
  context?: string;
}

export async function requestUserInput(
  db: DB,
  runId: string,
  input: RequestUserInputParams,
): Promise<Result<AgentRequest>> {
  try {
    const request = await insertAgentRequest(db, {
      run_id: runId,
      kind: input.kind,
      prompt: input.prompt,
      context: input.context,
    });
    return ok(request);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
