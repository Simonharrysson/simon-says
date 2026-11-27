"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { BoardStep } from "@/components/onboarding/steps";
import { InviteByEmail, sendInvites } from "@/components/views/InviteByEmail";
import type { InviteRow } from "@/lib/invites/rules";
import type { BoardRow } from "@/lib/people/board";
import {
  addBoardPersonAction,
  removeBoardPersonAction,
  updateBoardPersonAction,
  type ActionResult,
} from "@/app/(app)/orgs/[id]/kom-igang/actions";

/**
 * The förening's one board list: names, roles, e-mail and account status, with every way in.
 * Inställningar → "Styrelsen och medlemmar" and Kom igång's step 2 both render it. A person's
 * invite goes out from their row; "Bjud in via mejl" (several addresses) and "Dela länk" are
 * folded under the list. On the förening page each member's row also has their account controls.
 */
export function OrgBoard({
  orgId,
  orgName,
  rows,
  inviteUrl,
  myEmail,
  invites: initialInvites,
  inviterName,
  memberControls,
  linkActions,
}: {
  orgId: string;
  orgName: string;
  rows: BoardRow[];
  inviteUrl: string;
  myEmail: string | null;
  invites: InviteRow[];
  /** The name the invite e-mail says invites. */
  inviterName: string;
  memberControls?: Record<string, ReactNode>;
  /** Under "Dela länk" (Inställningar: "Skapa ny länk"). */
  linkActions?: ReactNode;
}) {
  const router = useRouter();
  const t = useTranslations("onboarding");
  const it = useTranslations("invites");
  const offline = t("offlineShort");
  const [invites, setInvites] = useState(initialInvites);
  const [seen, setSeen] = useState(initialInvites);
  if (seen !== initialInvites) {
    setSeen(initialInvites);
    setInvites(initialInvites);
  }
  const done = (r: Promise<ActionResult>) =>
    r.then(
      (x) => {
        router.refresh();
        return x.ok ? null : x.message;
      },
      () => offline,
    );
  return (
    <BoardStep
      orgName={orgName}
      rows={rows}
      inviteUrl={inviteUrl}
      myEmail={myEmail}
      invites={invites}
      memberControls={memberControls}
      linkActions={linkActions}
      inviteEmail={
        <InviteByEmail
          orgId={orgId}
          orgName={orgName}
          inviterName={inviterName}
          inviteUrl={inviteUrl}
          invites={invites}
          memberEmails={rows.flatMap((r) => (r.member?.email ? [r.member.email.toLowerCase()] : []))}
          onInvitesChange={setInvites}
        />
      }
      onInvite={async (email) => {
        const res = await sendInvites(orgId, [email.toLowerCase()], false, { failed: it("sendFailed"), offline: it("offline") });
        if (!res.ok) return res.message;
        setInvites(res.invites);
        const outcome = res.results[0];
        return outcome && outcome.result !== "sent" ? it(`result.${outcome.result}`) : null;
      }}
      onAdd={(input, member) =>
        addBoardPersonAction(orgId, input, member).then(
          (x) => {
            router.refresh();
            return x.ok ? null : x.editPersonId ? { message: x.message, editPersonId: x.editPersonId } : x.message;
          },
          () => offline,
        )
      }
      onUpdate={(id, input) => done(updateBoardPersonAction(orgId, id, input))}
      onRemove={(id) => done(removeBoardPersonAction(orgId, id))}
    />
  );
}
