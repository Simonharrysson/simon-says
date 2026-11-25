import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

const key = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The org's person with this name (any case), added if missing. Safe against a concurrent add
 * and a lost answer: people has a unique index on (org_id, lower(btrim(name))) (0016), so a
 * second insert fails with 23505 and the existing row is read instead.
 */
export async function ensurePerson(orgId: string, name: string): Promise<{ id: string; name: string }> {
  const db = supabaseAdmin();
  const find = async () => {
    const { data, error } = await db.from("people").select("id, name").eq("org_id", orgId);
    if (error) throw new Error(`people: ${error.message}`);
    return ((data ?? []) as { id: string; name: string }[]).find((p) => key(p.name) === key(name)) ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  const { data, error } = await db.from("people").insert({ org_id: orgId, name }).select("id, name").single();
  if (!error) return data as { id: string; name: string };
  const again = await find(); // 23505 (added meanwhile) or a lost answer
  if (again) return again;
  throw new Error(`people: add: ${error.message}`);
}
