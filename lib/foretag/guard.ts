import "server-only";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Förening-only features (Förbered möte, formats, goals, protocol import, the meeting folder,
// Kom igång) never run for a Företag (0050): several read meetings with the service role and
// would step around the company's visibility rule. Their pages 404 and their APIs answer 404.

/** Is this org a Företag? A read failure counts as yes (refuse: the safe side). */
export async function isForetagOrg(orgId: string): Promise<boolean> {
  if (!isUuid(orgId)) return false;
  const { data, error } = await supabaseAdmin().from("orgs").select("kind").eq("id", orgId).maybeSingle();
  if (error) {
    console.error(`foretag guard: ${error.message}`);
    return true;
  }
  return (data as { kind?: string } | null)?.kind === "foretag";
}

/** A route handler's refusal for a Företag, or null to go on. */
export async function refuseForetag(orgId: string): Promise<NextResponse | null> {
  return (await isForetagOrg(orgId)) ? NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } }) : null;
}
