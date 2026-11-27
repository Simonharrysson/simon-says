"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { BoardStep } from "@/components/onboarding/steps";
import type { InviteRow } from "@/lib/invites/rules";
import type { BoardRow } from "@/lib/people/board";
import {
  addBoardPersonAction,
  removeBoardPersonAction,
  undoSelfLinkAction,
  updateBoardPersonAction,
  type ActionResult,
} from "@/app/(app)/orgs/[id]/kom-igang/actions";

/**
 * Inställningar → "Styrelsen och medlemmar": Kom igång's one board list (names, roles, e-mail and
 * account status) on the förening page, with the same actions as step 2, plus each member's
 * account controls (admin handover, remove, leave) from the page.
 */
export function OrgBoard({
  orgId,
  orgName,
  rows,
  inviteUrl,
  myEmail,
  invites,
  memberControls,
}: {
  orgId: string;
  orgName: string;
  rows: BoardRow[];
  inviteUrl: string;
  myEmail: string | null;
  invites: InviteRow[];
  memberControls: Record<string, ReactNode>;
}) {
  const router = useRouter();
  const t = useTranslations("onboarding");
  const offline = t("offlineShort");
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
      showInvite={false}
      memberControls={memberControls}
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
      onUndoSelfLink={(id) => done(undoSelfLinkAction(orgId, id))}
    />
  );
}
