import type { SupabaseClient } from "@supabase/supabase-js";

export type AgentEvent = {
  /**
   * thought: the model's reasoning for one step (reasoning models only);
   * reasoning streams the same text live.
   * note: the agent's one-line narration before a batch of tool calls.
   * tool-call / tool-result: one tool use, paired by payload.callId.
   * questions: the agent asked the user to fill in a short brief.
   * token / draft / message: live-only (streamed text, the file being
   * written, the final reply — which is stored in `messages` instead).
   * continue: this invocation ran out of time with work left, or finished a
   * step (plan, build) with the next one to go; the client re-POSTs with resume:true.
   * payload.progressed: it got further (sources read, notes saved, a part or a
   * file written), so the client doesn't count it against its continuation cap.
   * phase: a new step of a split request starts (payload.name: split | research | plan | build | check).
   * plan: the plan the planning step handed in (payload.plan).
   */
  type: "thought" | "reasoning" | "note" | "tool-call" | "tool-result" | "questions" | "error" | "done" | "continue" | "token" | "draft" | "message" | "phase" | "plan";
  payload: Record<string, unknown>;
};

const LIVE_ONLY = new Set(["token", "reasoning", "draft", "message"]);

/** Append-only event log, persisted to Supabase and streamed live. */
export function makeEmitter(db: SupabaseClient, projectId: string, onEvent?: (e: AgentEvent & { id?: string; created_at?: string }) => void) {
  return async function emit(e: AgentEvent) {
    if (LIVE_ONLY.has(e.type)) {
      onEvent?.(e);
      return;
    }
    const created_at = new Date().toISOString();
    const { data } = await db
      .from("events")
      .insert({ project_id: projectId, role: "agent", type: e.type, payload: e.payload, created_at })
      .select("id")
      .single();
    onEvent?.({ ...e, id: data?.id, created_at });
  };
}

export type Emit = ReturnType<typeof makeEmitter>;
