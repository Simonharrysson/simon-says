import { allSources } from "@/lib/memory/memory";
import { loadMemory, sourceMeetings } from "@/lib/memory/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { OrgMemory } from "./OrgMemory";

/** Vad Claude ska veta (0065), read as the admin (org_memory RLS; source links only to meetings they see). */
export async function OrgMemorySlot({ orgId }: { orgId: string }) {
  const db = await createSupabaseServerClient();
  const memory = await loadMemory(db, orgId);
  const sources = await sourceMeetings(db, allSources(memory.lines));
  return <OrgMemory orgId={orgId} memory={memory} sources={sources} />;
}
