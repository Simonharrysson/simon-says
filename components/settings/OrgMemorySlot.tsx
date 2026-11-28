import { loadMemoryFor } from "@/lib/memory/store";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { OrgMemory } from "./OrgMemory";

/**
 * Vad Claude ska veta (0065), read on the server for an admin: only the lines whose every source
 * meeting they can still see (their own client, meetings RLS), with links to those meetings.
 */
export async function OrgMemorySlot({ orgId }: { orgId: string }) {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  const page = user ? await loadMemoryFor(db, supabaseAdmin(), orgId, user.id) : null;
  if (!page) return null;
  return <OrgMemory orgId={orgId} memory={page.memory} sources={page.sources} />;
}
