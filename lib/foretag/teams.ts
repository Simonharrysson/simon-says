import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getLocale, getTranslations } from "next-intl/server";
import { listGroups } from "@/lib/db/foretag";
import type { GroupRow } from "@/lib/foretag/tree";
import { labelTeams } from "@/lib/groups/teams";

/**
 * The org's groups as people see them (0062): "Simons team", never a group's internal name. For
 * "Möte för", the meetings list and the visibility line. Read with the caller's client (RLS).
 */
export async function listTeams(db: SupabaseClient, orgId: string): Promise<GroupRow[]> {
  const [groups, people, t, locale] = await Promise.all([
    listGroups(db, orgId),
    db.from("people").select("id, name").eq("org_id", orgId),
    getTranslations("foretag.teams"),
    getLocale(),
  ]);
  const heads = new Map(((people.data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  return labelTeams(groups, heads, { team: (owner) => t("team", { owner }), top: t("top") }, locale);
}
