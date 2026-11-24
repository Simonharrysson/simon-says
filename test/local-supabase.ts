import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Tests against the local Supabase stack (`supabase start` + `supabase db reset`). CI exports
// LOCAL_SUPABASE_API_URL / _ANON_KEY / _SERVICE_ROLE_KEY from `supabase status -o env`.
// Without them the DB tests skip locally, but fail in CI so they can never silently not run.

const url = process.env.LOCAL_SUPABASE_API_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;

export const hasLocalSupabase = Boolean(url && anonKey && serviceKey);
if (!hasLocalSupabase && process.env.CI) {
  throw new Error("LOCAL_SUPABASE_* env missing in CI: DB tests would not run");
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };

export function adminClient(): SupabaseClient {
  return createClient(url!, serviceKey!, options);
}

export function anonClient(): SupabaseClient {
  return createClient(url!, anonKey!, options);
}

export interface TestUser {
  id: string;
  email: string;
  db: SupabaseClient;
}

/** A fresh confirmed user, signed in on its own client. */
export async function createTestUser(label: string): Promise<TestUser> {
  const email = `${label}-${randomUUID()}@test.local`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  const db = anonClient();
  const { error: signInError } = await db.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn: ${signInError.message}`);
  return { id: data.user.id, email, db };
}

/** A meeting with one session, a speaker, a note and an event, written as the server would. */
export async function seedMeeting(orgId: string, startedBy: string): Promise<{ meetingId: string; sessionId: string }> {
  const admin = adminClient();
  const sessionId = `el-${randomUUID()}`;
  const { data: meeting, error } = await admin
    .from("meetings")
    .insert({ org_id: orgId, started_by: startedBy, doc_id: "doc", notes_tab_id: "t.notes" })
    .select("id")
    .single();
  if (error) throw new Error(`seed meeting: ${error.message}`);
  const meetingId = meeting.id as string;
  // Sequential: the session must exist before the meeting and speaker map point at it.
  const writes = [
    () => admin.from("el_sessions").insert({ id: sessionId, meeting_id: meetingId, max_seconds: 3600 }),
    () => admin.from("meetings").update({ current_el_session_id: sessionId }).eq("id", meetingId),
    () =>
      admin.from("speaker_map").insert({
        meeting_id: meetingId,
        el_session_id: sessionId,
        speaker_label: "speaker_0",
        display_name: "Talare 1",
      }),
    () => admin.from("note_items").insert({ meeting_id: meetingId, id: "n1", section: "decision", text: "Vi kör" }),
    () => admin.from("meeting_events").insert({ meeting_id: meetingId, kind: "tick_ok" }),
  ];
  for (const write of writes) {
    const { error: e } = await write();
    if (e) throw new Error(`seed: ${e.message}`);
  }
  return { meetingId, sessionId };
}

/** Row count as the service role (sees everything). */
export async function countRows(table: string, column: string, value: string): Promise<number> {
  const { count, error } = await adminClient().from(table).select("*", { count: "exact", head: true }).eq(column, value);
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}
