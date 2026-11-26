"use client";

import type { ReactNode } from "react";
import { OnboardingShell, StepFooter } from "@/components/onboarding/OnboardingShell";
import { BoardStep } from "@/components/onboarding/steps";
import { InviteByEmail, type AddressOutcome, type SendInvites } from "@/components/views/InviteByEmail";
import { OrgDetailView, type OrgDetailViewProps } from "@/components/views/OrgDetailView";
import { Panel } from "@/components/ui/Panel";
import type { InviteRow } from "@/lib/invites/rules";
import type { BoardRow } from "@/lib/people/board";

// "Bjud in via mejl" (0038) in the /design gallery. Fictional förening, example.com addresses;
// `send` is a fake that answers like the route (nothing is sent).

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORG = "Exempelföreningen";
const INVITE = "https://simonsays.harrysson.co/join/Xk3fQ9pLm2";
const INVITER = "Anna Berg";
const noop = () => {};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const INVITES: InviteRow[] = [
  { email: "erik.lund@example.com", status: "sent", lastSentAt: hoursAgo(2), acceptedAt: null, recentSends: 1, nextResendAt: inHours(22) },
  { email: "maja.holm@example.com", status: "sent", lastSentAt: hoursAgo(1), acceptedAt: null, recentSends: 2, nextResendAt: inHours(20) },
  { email: "karin.sjo@example.com", status: "failed", lastSentAt: null, acceptedAt: null, recentSends: 0, nextResendAt: null },
  { email: "johan.ek@example.com", status: "accepted", lastSentAt: hoursAgo(50), acceptedAt: hoursAgo(30), recentSends: 0, nextResendAt: null },
];

const RESULTS: AddressOutcome[] = [
  { email: "erik.lund@example.com", result: "sent" },
  { email: "johan.ek@example.com", result: "member" },
  { email: "erik.lund@exampel", result: "invalid" },
  { email: "karin.sjo@example.com", result: "failed" },
];

/** Answers like the route: example.com addresses are sent, "fel" in the address fails. */
const fakeSend: SendInvites = async (emails) => {
  await new Promise((r) => setTimeout(r, 600));
  const results: AddressOutcome[] = emails.map((email) => ({ email, result: email.includes("fel") ? "failed" : "sent" }));
  const now = new Date().toISOString();
  const sent: InviteRow[] = results.map((r) => ({ email: r.email, status: r.result === "sent" ? "sent" : "failed", lastSentAt: r.result === "sent" ? now : null, acceptedAt: null, recentSends: r.result === "sent" ? 1 : 0, nextResendAt: null }));
  return { ok: true, results, invites: [...sent, ...INVITES.filter((i) => !emails.includes(i.email))] };
};

function InvitePanel({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[26rem] px-4">
      <Panel title="Bjud in" titleId="invite-demo-title">
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Bjud in via mejl</h3>
          {children}
        </section>
      </Panel>
    </div>
  );
}

const base = { orgId: ORG_ID, orgName: ORG, inviterName: INVITER, inviteUrl: INVITE, send: fakeSend, memberEmails: ["anna.berg@example.com", "johan.ek@example.com"] };

const boardRows: BoardRow[] = [
  { personId: "p1", name: "Anna Berg", role: "Ordförande", email: "anna.berg@example.com", status: "account", member: { userId: "u1", email: "anna.berg@example.com", role: "admin" }, voiceConsent: false },
  { personId: "p2", name: "Erik Lund", role: "Kassör", email: "erik.lund@example.com", status: "invited", member: null, voiceConsent: false },
  { personId: "p5", name: "Lina Strand", role: "Ledamot", email: "lina.strand@example.com", status: "invited", member: null, voiceConsent: false },
  { personId: "p3", name: "Sara Nyström", role: "Sekreterare", email: null, status: "name", member: null, voiceConsent: false },
];

const orgActions: OrgDetailViewProps["actions"] = {
  rotateInvite: async () => {},
  addPerson: async () => {},
  renamePerson: async () => {},
  deletePerson: async () => {},
  deleteMeeting: async () => {},
  updateOrg: async () => {},
  deleteOrg: async () => {},
};


export const inviteRender: Record<string, () => ReactNode> = {
  "invite-email": () => (
    <InvitePanel>
      <InviteByEmail {...base} invites={[]} />
    </InvitePanel>
  ),
  "invite-email-preview": () => (
    <InvitePanel>
      <InviteByEmail {...base} invites={[]} initialPreview initialText={"Erik Lund <erik.lund@example.com>, maja.holm@example.com\njohan.ek@example.com\nkarin.sjo@exampel"} />
    </InvitePanel>
  ),
  "invite-email-results": () => (
    <InvitePanel>
      <InviteByEmail {...base} invites={INVITES} initialResults={RESULTS} initialText="karin.sjo@example.com" />
    </InvitePanel>
  ),
  "invite-email-org": () => (
    <OrgDetailView
      org={{ id: ORG_ID, name: ORG, share_transcript: true, show_on_status: false }}
      isAdmin
      userId="u1"
      inviteUrl={INVITE}
      members={[
        { userId: "u1", email: "anna.berg@example.com", role: "admin" },
        { userId: "u4", email: "johan.ek@example.com", role: "member" },
      ]}
      people={[
        { id: "p1", name: "Anna Berg", role: "Ordförande", member_user_id: "u1" },
        { id: "p2", name: "Erik Lund", role: "Kassör", email: "erik.lund@example.com", member_user_id: null },
      ]}
      meetings={[]}
      notice={null}
      inviteByEmail={<InviteByEmail {...base} invites={INVITES.slice(0, 2)} />}
      actions={orgActions}
    />
  ),
  "invite-email-onboarding": () => (
    <OnboardingShell
      orgName={ORG}
      orgHref="#"
      logoUrl={null}
      step="styrelsen"
      done={["namn"]}
      skipped={[]}
      onGo={noop}
      title="Vilka sitter i styrelsen?"
      lead="En lista för alla: namn och roll för anteckningarna, e-post för den som ska kunna starta möten."
      footer={<StepFooter onBack={noop} onSkip={noop} onNext={noop} />}
    >
      <BoardStep
        orgName={ORG}
        rows={boardRows}
        inviteUrl={INVITE}
        myEmail="anna.berg@example.com"
        invites={INVITES.slice(0, 1)}
        inviteEmail={<InviteByEmail {...base} invites={INVITES.slice(0, 1)} suggestions={["lina.strand@example.com"]} />}
        onAdd={async () => null}
        onUpdate={async () => null}
        onRemove={async () => null}
      />
    </OnboardingShell>
  ),
};
