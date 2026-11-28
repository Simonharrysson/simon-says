import type { OrgMember } from "@/lib/db/members";

/**
 * Who a new Doc is shared with (writer). The starter's own grant made it: the förening's other
 * members with an email (the starter owns it). The förening's Drive account made it (0070): every
 * member but that account itself, the starter included (they don't own it). `shareTo` (the tree,
 * 0050/0054): only those accounts.
 */
export function docShareTargets(
  members: OrgMember[],
  ctx: { user: { id: string; email?: string | null }; shareTo?: Set<string> | null; driveAccountEmail?: string | null },
): OrgMember[] {
  const owner = (ctx.driveAccountEmail ?? ctx.user.email ?? "").toLowerCase();
  const orgOwned = Boolean(ctx.driveAccountEmail);
  return members.filter(
    (m) =>
      Boolean(m.email) &&
      m.email.toLowerCase() !== owner &&
      (orgOwned || m.userId !== ctx.user.id) &&
      (!ctx.shareTo || ctx.shareTo.has(m.userId)),
  );
}
