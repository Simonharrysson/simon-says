// "Vem av dessa är du?" (UX walkthrough 2026-11-27, 3): after joining a förening by its link, the
// new member links their account to their name in the people list (claim_person, 0051) or adds
// themselves (add_self_person). Until then tasks, speaker names and summary mails can't find them.

export interface WhoamiPerson {
  id: string;
  name: string;
  role?: string | null;
  member_user_id: string | null;
}

/** Is the account linked to a person of this förening? */
export function isLinked(people: Pick<WhoamiPerson, "member_user_id">[], userId: string): boolean {
  return people.some((p) => p.member_user_id === userId);
}

/** The people a new member can pick: nobody is linked to them yet. Sorted by name (Swedish order). */
export function claimable(people: WhoamiPerson[]): { id: string; name: string; role: string | null }[] {
  return people
    .filter((p) => p.member_user_id === null)
    .map((p) => ({ id: p.id, name: p.name, role: p.role ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

/** Where "Gå med" lands: the förening's welcome when the e-mail already linked them, else the picker. */
export function afterJoinPath(orgId: string, linked: boolean): string {
  return linked ? welcomePath(orgId) : `/orgs/${orgId}/vem`;
}

export const welcomePath = (orgId: string) => `/orgs/${orgId}?valkommen=1`;

/** A refusal from claim_person / add_self_person, as the picker's `?fel=` code. */
export type WhoamiError = "upptagen" | "redan" | "namn" | "roll" | "fel";

export function whoamiError(result: string): WhoamiError | null {
  if (result === "ok") return null;
  if (result === "taken") return "upptagen";
  if (result === "already") return "redan";
  if (result === "invalid") return "namn";
  return "fel";
}

export function parseWhoamiError(raw: string | undefined): WhoamiError | null {
  return raw === "upptagen" || raw === "redan" || raw === "namn" || raw === "roll" || raw === "fel" ? raw : null;
}

/** A first guess for "Jag finns inte med": the Google account's name, when it is one. */
export function suggestedName(meta: Record<string, unknown> | undefined | null): string {
  const raw = meta?.full_name ?? meta?.name;
  return typeof raw === "string" ? raw.trim().slice(0, 100) : "";
}
