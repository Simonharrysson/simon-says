"use client";

import { useState, type ReactNode } from "react";
import { KomIgangCard } from "@/components/onboarding/KomIgangCard";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { OnboardingShell, StepFooter, type ShellStep } from "@/components/onboarding/OnboardingShell";
import { BoardStep, DoneStep, FolderStep, FormatStep, HistoryStep, LogoStep, VoicesStep, type StadgarPhase, type WeeklyChoice } from "@/components/onboarding/steps";
import { LearnFormatView } from "@/components/views/FormatEditor";
import { OrgDetailView, type OrgDetailViewProps } from "@/components/views/OrgDetailView";
import { OrgsView } from "@/components/views/OrgsView";
import type { StepId } from "@/lib/onboarding/steps";
import type { BoardRow } from "@/lib/people/board";

// Kom igång (todo #5) in the /design gallery. Everything is fictional: an invented förening,
// invented people and example.com addresses.

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ORG = "Exempelföreningen";
const INVITE = "https://simonsays.harrysson.co/join/Xk3fQ9pLm2";
const noop = () => {};
const noopAsync = async () => null;

/** A fictional logo: a monogram on teal, as an inline SVG. */
export const DEMO_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#0f5e59"/><circle cx="128" cy="128" r="84" fill="none" stroke="#f3e9d2" stroke-width="10"/><text x="128" y="160" font-family="Georgia,serif" font-size="96" text-anchor="middle" fill="#f3e9d2">Ef</text></svg>`,
  );

const boardRows: BoardRow[] = [
  { personId: "p1", name: "Anna Berg", role: "Ordförande", email: "anna.berg@example.com", status: "account", member: { userId: "u1", email: "anna.berg@example.com", role: "admin" }, voiceConsent: true },
  { personId: "p2", name: "Erik Lund", role: "Kassör", email: "erik.lund@example.com", status: "invited", member: null, voiceConsent: false },
  { personId: "p3", name: "Sara Nyström", role: "Sekreterare", email: null, status: "name", member: null, voiceConsent: true },
  { personId: null, name: null, role: null, email: "johan.ek@example.com", status: "account", member: { userId: "u4", email: "johan.ek@example.com", role: "member" }, voiceConsent: false },
];

function Frame({ step, done = [], skipped = [], children, footer, logo = null, title, lead }: { step: ShellStep; done?: StepId[]; skipped?: StepId[]; children: ReactNode; footer?: ReactNode; logo?: string | null; title: string; lead?: string }) {
  return (
    <OnboardingShell orgName={ORG} orgHref="#" logoUrl={logo} step={step} done={done} skipped={skipped} onGo={noop} title={title} lead={lead} footer={footer}>
      {children}
    </OnboardingShell>
  );
}

const footer = (first = false, nextLabel?: string) => <StepFooter onBack={first ? undefined : noop} onSkip={first ? undefined : noop} onNext={noop} nextLabel={nextLabel} />;

function LogoDemo({ withLogo }: { withLogo: boolean }) {
  const [name, setName] = useState(ORG);
  return (
    <Frame step="namn" logo={withLogo ? DEMO_LOGO : null} title="Välkommen! Hur ser ni ut?" lead="Kontrollera namnet och lägg gärna till er logga, så känner alla igen föreningen." footer={footer(true)}>
      <LogoStep orgName={name} logoUrl={withLogo ? DEMO_LOGO : null} onFile={noop} onRemove={noop} name={name} onName={setName} message={withLogo ? { text: "Loggan är sparad.", tone: "success" } : null} />
    </Frame>
  );
}

function BoardDemo({ rows }: { rows: BoardRow[] }) {
  const [list, setList] = useState(rows);
  return (
    <Frame step="styrelsen" done={["namn"]} logo={DEMO_LOGO} title="Vilka sitter i styrelsen?" lead="En lista för alla: namn och roll för anteckningarna, e-post för den som ska kunna starta möten." footer={footer()}>
      <BoardStep
        orgName={ORG}
        rows={list}
        inviteUrl={INVITE}
        myEmail="anna.berg@example.com"
        onAdd={async (input) => {
          setList((l) => [...l, { personId: `n${l.length}`, name: input.name, role: input.role || null, email: input.email || null, status: input.email ? "invited" : "name", member: null, voiceConsent: false }]);
          return null;
        }}
        onUpdate={noopAsync}
        onRemove={async (id) => {
          setList((l) => l.filter((r) => r.personId !== id));
          return null;
        }}
      />
    </Frame>
  );
}

function FormatDemo({ stadgar, choice: initial = "veckomote", learnOpen }: { stadgar: StadgarPhase; choice?: WeeklyChoice; learnOpen?: boolean }) {
  const [choice, setChoice] = useState<WeeklyChoice>(learnOpen ? "learn" : initial);
  const [s, setS] = useState(stadgar);
  return (
    <Frame step="format" done={["namn", "styrelsen", "mapp"]} logo={DEMO_LOGO} title="Så brukar ni ha möten" lead="Simon Says skriver protokollet i er form. Det går att ändra när som helst." footer={footer()}>
      <FormatStep
        choice={choice}
        onChoice={setChoice}
        learn={<LearnFormatView orgId={ORG_ID} view={{ phase: "idle" }} onStart={noop} onCancel={noop} />}
        pickerEnabled
        stadgar={s}
        onStadgarPick={noop}
        onStadgarChange={(board, arsmote) => setS({ phase: "review", board, arsmote })}
        onStadgarSave={noop}
        onStadgarCancel={noop}
      />
    </Frame>
  );
}

function VoicesDemo({ empty }: { empty?: boolean }) {
  const [rows, setRows] = useState(boardRows.filter((r) => r.personId));
  return (
    <Frame step="roster" done={["namn", "styrelsen", "mapp", "format"]} skipped={["protokoll"]} logo={DEMO_LOGO} title="Röster (valfritt)" lead="Simon Says kan lära sig vem som pratar, så att ni slipper namnrundan varje gång." footer={footer(false, "Klar")}>
      <VoicesStep
        people={empty ? [] : rows.map((r) => ({ personId: r.personId!, name: r.name!, role: r.role, consent: r.voiceConsent }))}
        onConsent={(id, v) => setRows((l) => l.map((r) => (r.personId === id ? { ...r, voiceConsent: v } : r)))}
        onBoard={noop}
      />
    </Frame>
  );
}

const STADGAR_BOARD = ["Fråga om mötets behöriga utlysande", "Fråga om beslutsmässighet", "Ekonomisk rapport"];
const STADGAR_ARS = [
  "Mötets öppnande",
  "Fastställande av röstlängd",
  "Val av mötesordförande",
  "Val av mötessekreterare",
  "Val av två justerare tillika rösträknare",
  "Fråga om mötet är stadgeenligt utlyst",
  "Verksamhetsberättelse",
  "Ekonomisk berättelse",
  "Revisionsberättelse",
  "Fråga om ansvarsfrihet för styrelsen",
  "Fastställande av medlemsavgift",
  "Val av styrelse",
  "Val av revisorer",
  "Motioner",
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

export const onboardingRender: Record<string, () => ReactNode> = {
  // The real container (server actions answer "not admin" here; navigation still works).
  "onboarding-live": () => (
    <Onboarding
      org={{ id: ORG_ID, name: ORG, logoUpdatedAt: null, folderSet: false, folderName: null }}
      initialStep="namn"
      state={{ done: [], skipped: [], completedAt: null, dismissedAt: null }}
      board={boardRows}
      inviteUrl={INVITE}
      myEmail="anna.berg@example.com"
      invites={[]}
      inviterName="Anna Berg"
      pickerEnabled={false}
      format={{ kind: null, name: "Enkel", profile: null }}
      stadgarSaved={{ styrelse: false, arsmote: false }}
      historyCount={0}
    />
  ),
  "onboarding-1": () => <LogoDemo withLogo={false} />,
  "onboarding-1-logo": () => <LogoDemo withLogo />,
  "onboarding-2-empty": () => <BoardDemo rows={[]} />,
  "onboarding-2": () => <BoardDemo rows={boardRows} />,
  "onboarding-3-empty": () => (
    <Frame step="mapp" done={["namn", "styrelsen"]} logo={DEMO_LOGO} title="Var ska mötesdokumenten ligga?" lead="Simon Says skriver varje möte i ett Google-dokument. Välj en mapp i Drive som styrelsen delar." footer={footer()}>
      <FolderStep folderName={null} folderSet={false} pickerEnabled onPick={noop} />
    </Frame>
  ),
  "onboarding-3": () => (
    <Frame step="mapp" done={["namn", "styrelsen"]} logo={DEMO_LOGO} title="Var ska mötesdokumenten ligga?" lead="Simon Says skriver varje möte i ett Google-dokument. Välj en mapp i Drive som styrelsen delar." footer={footer()}>
      <FolderStep folderName="Styrelsen 2026–2027" folderSet pickerEnabled onPick={noop} message="Mötesmappen är sparad." />
    </Frame>
  ),
  "onboarding-4": () => <FormatDemo stadgar={{ phase: "idle" }} />,
  "onboarding-4-learn": () => <FormatDemo stadgar={{ phase: "idle" }} learnOpen />,
  "onboarding-4-reading": () => <FormatDemo stadgar={{ phase: "reading" }} />,
  "onboarding-4-stadgar": () => <FormatDemo stadgar={{ phase: "review", board: STADGAR_BOARD, arsmote: STADGAR_ARS }} />,
  "onboarding-4-saved": () => <FormatDemo stadgar={{ phase: "saved", board: 3, arsmote: 14 }} />,
  "onboarding-5": () => (
    <Frame step="protokoll" done={["namn", "styrelsen", "mapp", "format"]} logo={DEMO_LOGO} title="Era tidigare möten" lead="Läs in gamla protokoll, så vet Simon Says vad ni har beslutat och vad som är på gång – redan till första mötet." footer={footer()}>
      <HistoryStep importHref="#" historyCount={0} />
    </Frame>
  ),
  "onboarding-6": () => <VoicesDemo />,
  "onboarding-6-empty": () => <VoicesDemo empty />,
  "onboarding-klart": () => (
    <Frame step="klart" done={["namn", "styrelsen", "mapp", "format", "roster"]} skipped={["protokoll"]} logo={DEMO_LOGO} title="Nu är ni redo" lead="Nu kan ni förbereda första mötet. Det du hoppade över kan du göra när som helst.">
      <DoneStep done={["namn", "styrelsen", "mapp", "format", "roster"]} skipped={["protokoll"]} prepareHref="#" orgHref="#" onGo={noop} />
    </Frame>
  ),
  "org-kom-igang": () => (
    <OrgDetailView
      org={{ id: ORG_ID, name: ORG, share_transcript: true, show_on_status: false }}
      isAdmin
      userId="u1"
      inviteUrl={INVITE}
      members={[{ userId: "u1", email: "anna.berg@example.com", role: "admin" }]}
      people={[
        { id: "p1", name: "Anna Berg", role: "Ordförande", member_user_id: "u1" },
        { id: "p2", name: "Erik Lund", role: "Kassör", email: "erik.lund@example.com", member_user_id: null },
      ]}
      meetings={[]}
      notice={null}
      logoUrl={DEMO_LOGO}
      komIgang={<KomIgangCard orgId={ORG_ID} state={{ done: ["namn", "styrelsen"], skipped: ["mapp"], completedAt: null, dismissedAt: null }} onDismiss={async () => null} />}
      actions={orgActions}
    />
  ),
  "orgs-logos": () => (
    <OrgsView
      orgs={[
        { id: ORG_ID, name: ORG, role: "admin", logoUrl: DEMO_LOGO },
        { id: "00000000-0000-4000-8000-000000000002", name: "Golfklubben Tia", role: "member" },
      ]}
      notice={null}
      createOrg={async () => {}}
    />
  ),
};

