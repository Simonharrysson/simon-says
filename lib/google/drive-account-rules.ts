// Which Google account a förening's Drive work runs as (0070, "Använd ett annat Google-konto").
// Pure rules, unit tested (drive-account-rules.test.ts); lib/google/drive-account.ts applies them.
//
// Under drive.file a Doc or folder is reachable only through the grant that created or picked it,
// so the choice is made per Doc and recorded (meetings / prepared_agendas.drive_account_sub):
//   - a NEW Doc in the förening's meeting folder uses the förening's account while that account
//     picked the folder; otherwise the starter's own grant, exactly as before;
//   - an EXISTING Doc keeps the account that made it; a lost or replaced account is an error,
//     never a fallback to someone else's Drive.

/** The parts of an org_drive_accounts row the rules look at (never the token). */
export interface DriveAccountState {
  googleSub: string;
  googleEmail: string;
  connectedBy: string;
  folderId: string | null;
  lostAt: string | null;
  /** Another admin replaced the previous account (who, which address, when). */
  replacedBy?: string | null;
  replacedEmail?: string | null;
  replacedAt?: string | null;
}

export type CreationChoice =
  /** The starter's own grant (no förening account, no meeting folder, or a folder it did not pick). */
  | { use: "starter" }
  /** The förening's account; record `sub` on the new row. */
  | { use: "org"; sub: string }
  /** The förening's account owns the folder but Google refused it: renew it, write nowhere else. */
  | { use: "lost" };

/**
 * A new Doc for the meeting folder `folderId` (null: the meeting has no shared folder, as for a
 * group's or a private meeting, which always stay in the starter's own Drive).
 */
export function chooseCreationAccount(account: DriveAccountState | null, folderId: string | null): CreationChoice {
  if (!folderId || !account) return { use: "starter" };
  if (account.folderId !== folderId) return { use: "starter" };
  if (account.lostAt) return { use: "lost" };
  return { use: "org", sub: account.googleSub };
}

export type ExistingChoice = { use: "starter" } | { use: "org" } | { use: "lost" };

/** An existing Doc made with `docSub` (null: the starter's own grant). */
export function chooseExistingAccount(account: DriveAccountState | null, docSub: string | null | undefined): ExistingChoice {
  if (!docSub) return { use: "starter" };
  if (!account || account.googleSub !== docSub || account.lostAt) return { use: "lost" };
  return { use: "org" };
}

export type PickerChoice = { use: "own" } | { use: "org" } | { use: "lost" };

/**
 * Whose Picker (and whose grant reads what it picked): the förening's account only for the admin
 * who connected it; everyone else keeps their own.
 */
export function choosePickerAccount(account: DriveAccountState | null, userId: string): PickerChoice {
  if (!account || account.connectedBy !== userId) return { use: "own" };
  return account.lostAt ? { use: "lost" } : { use: "org" };
}

/** Who may disconnect: any admin of the förening, and the user who connected it. */
export function mayDisconnect(account: Pick<DriveAccountState, "connectedBy">, userId: string, isAdmin: boolean): boolean {
  return isAdmin || account.connectedBy === userId;
}

/** What the folder card shows an admin (never the token). */
export interface DriveAccountView {
  email: string;
  /** Google refused the token: "Drive-kopplingen behöver förnyas". */
  lost: boolean;
  /** The meeting folder was picked with this account (else: pick it again in this account). */
  folderPicked: boolean;
  /** The viewer connected it (only they get its Picker). */
  mine: boolean;
  /** "Kopplat av <namn>": who connected it (their name in the förening, else their address). */
  connectedByName: string | null;
  /** Shown for 30 days after another admin replaced the account: the address it replaced and by whom. */
  replaced: { email: string; byName: string | null; at: string } | null;
}

/** How long the folder card tells the other admins that the account was replaced. */
export const REPLACED_NOTICE_DAYS = 30;

export function driveAccountView(
  account: DriveAccountState | null,
  userId: string,
  meetingFolderId: string | null,
  nameOf: (userId: string) => string | null = () => null,
  now = new Date(),
): DriveAccountView | null {
  if (!account) return null;
  const recent = account.replacedAt && now.getTime() - Date.parse(account.replacedAt) < REPLACED_NOTICE_DAYS * 86_400_000;
  return {
    email: account.googleEmail,
    lost: Boolean(account.lostAt),
    folderPicked: Boolean(meetingFolderId) && account.folderId === meetingFolderId,
    mine: account.connectedBy === userId,
    connectedByName: nameOf(account.connectedBy),
    // Not to the admin who replaced it: they know.
    replaced:
      recent && account.replacedEmail && account.replacedBy !== userId
        ? { email: account.replacedEmail, byName: account.replacedBy ? nameOf(account.replacedBy) : null, at: account.replacedAt! }
        : null,
  };
}

/** A member's name for the folder card: their name on the board, else their sign-in address. */
export function memberNames(people: { member_user_id?: string | null; name?: string | null }[], members: { userId: string; email: string }[]): (userId: string) => string | null {
  return (id) => people.find((p) => p.member_user_id === id && p.name)?.name ?? members.find((m) => m.userId === id)?.email ?? null;
}

/** `?drivekonto=` on the page the consent or "Koppla från" returned to; anything else: none. */
export function driveResultOf(v: string | string[] | undefined | null): "ok" | "nej" | "fel" | "bort" | null {
  return v === "ok" || v === "nej" || v === "fel" || v === "bort" ? v : null;
}
