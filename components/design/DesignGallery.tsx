"use client";

import type { CaptureSource, TabAudioSupport } from "@/lib/audio/call";
import { CallSetup, type CallShareError } from "@/components/live/CallSetup";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import type { Locale } from "@/lib/i18n/config";
import { AgendaStepView, type AgendaFormatOption, type AgendaStepViewProps, type AgendaViewState, type GoalOption } from "@/components/live/AgendaStep";
import { LiveMeeting, type LiveMeetingProps } from "@/components/live/LiveMeeting";
import type { TaskView } from "@/lib/notes/tasks";
import type { Speaker } from "@/components/live/types";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Check, Field } from "@/components/ui/Field";
import { IconArrowRight, IconMic, IconPlus, IconTrash } from "@/components/ui/icons";
import { Label } from "@/components/ui/label";
import { ListRow } from "@/components/ui/ListRow";
import { NativeSelect } from "@/components/ui/native-select";
import { Panel } from "@/components/ui/Panel";
import { SiteFooter } from "@/components/ui/SiteFooter";
import { navLinkClass, SiteHeader } from "@/components/ui/SiteHeader";
import { AccountView } from "@/components/views/AccountView";
import { MailPrefsView } from "@/components/views/MailPrefsView";
import { AppNav } from "@/components/views/AppNav";
import { JoinView } from "@/components/views/JoinView";
import { WhoamiView } from "@/components/views/WhoamiView";
import { WelcomeCard } from "@/components/views/WelcomeCard";
import { LoginView } from "@/components/views/LoginView";
import { FormatCard } from "@/components/views/FormatCard";
import { LearnFormatView, type LearnPhase } from "@/components/views/FormatEditor";
import { OrgDetailView, type OrgDetailViewProps, type OrgTab } from "@/components/views/OrgDetailView";
import { BoardStep } from "@/components/onboarding/steps";
import type { BoardRow } from "@/lib/people/board";
import { OrgDetailsForm } from "@/components/settings/OrgDetails";
import { MeetingFolderSetting, VoicesSetting } from "@/components/settings/MeetingSettings";
import { OrgCalendarForm } from "@/components/calendar/OrgCalendarForm";
import { InviteByEmail } from "@/components/views/InviteByEmail";
import type { SettingsSectionId } from "@/lib/orgs/tabs";
import { OrgsView } from "@/components/views/OrgsView";
import { PrepareMeetingView, type PreparePhase, type PrepareMeetingViewProps } from "@/components/views/PrepareMeeting";
import { NextMeetingHero, type NextMeetingHeroProps } from "@/components/views/NextMeetingHero";
import { MeetingMoreMenu } from "@/components/views/MeetingMoreMenu";
import type { HeroState } from "@/lib/meetings/next-meeting";
import type { DraftItem, MeetingType } from "@/lib/prepare/types";
import { OverviewView, type GoalsPhase, type OverviewGoal } from "@/components/views/OverviewView";
import type { Overview } from "@/lib/dashboard/overview";
import { StatusView } from "@/components/views/StatusView";
import { STYRELSEPROTOKOLL, VECKOMOTE } from "@/lib/formats/standard";
import { StadgarArsmote } from "@/components/views/StadgarArsmote";
import { orgNotice, orgsNotice } from "@/lib/ui/messages";
import { demoGoals, demoOverview, demoOverviewHistoryOnly, demoOverviewWithHistory, demoProposal, emptyOverview, OVERVIEW_NOW } from "./overview-demo";
import { IMPORT_DEMO_NOW, largeDigesting, largeDone, largeRunning, largeStarted, smallFailed, smallRunning } from "./import-demo";
import { designViews, type DesignGroup } from "./registry";
import { onboardingRender } from "./onboarding-demo";
import { SummarySettingsDemo, summaryRender } from "./summary-demo";
import { inviteRender } from "./invite-demo";
import { privatRender } from "./privat-demo";
import { briefRender } from "./brief-demo";
import { homeRender } from "./home-demo";
import { ContextPicker } from "@/components/privat/ContextPicker";

const WHOAMI_PEOPLE = [
  { id: "p1", name: "Erik Lund", role: "Ledamot" },
  { id: "p2", name: "Johan Ek", role: null },
  { id: "p3", name: "Sara Nyström", role: "Kassör" },
];

function StadgarLead() {
  return <p className="text-sm text-ink-2">{useTranslations("stadgar")("lead")}</p>;
}

/** Gives a gallery view the UI language (the notices are copy, not gallery chrome). */
function WithLocale({ render }: { render: (locale: Locale) => ReactNode }) {
  return <>{render(useLocale())}</>;
}

// Everything below is fake, illustrative data. No real people, orgs or ids.

const noop = () => {};
const noopAction = async () => {};
/** Saves nothing; answers after a short wait so "Sparat" shows like it does live. */
const fakeSave = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300));
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-0000000000aa";
const NOW = Date.parse("2026-11-24T18:42:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const people = [
  { id: "p1", name: "Anna Berg" },
  { id: "p2", name: "Erik Lund" },
  { id: "p3", name: "Sara Nyström" },
  { id: "p4", name: "Simon" },
  { id: "p5", name: "Johan Ek" },
];

const actions: OrgDetailViewProps["actions"] = {
  removeMember: noopAction,
  leaveOrg: noopAction,
  setMemberRole: noopAction,
  rotateInvite: noopAction,
  addPerson: noopAction,
  renamePerson: noopAction,
  deletePerson: noopAction,
  deleteMeeting: noopAction,
  updateOrg: noopAction,
  deleteOrg: noopAction,
};

const org = { id: ORG_ID, name: "Exempelföreningen", share_transcript: true, show_on_status: false };
// "Om oss" (todo #13): fictional text and example links.
const orgProfile = {
  about: "Vi är en ideell förening för golfintresserade i alla åldrar.\nVi spelar varje tisdag från maj till september och avslutar säsongen med en klubbmatch.",
  website_url: "https://exempel.se/",
  facebook_url: "https://facebook.com/exempel",
  instagram_url: "https://instagram.com/exempel",
};

const speakers: Speaker[] = [
  { elSessionId: "s1", speakerLabel: "0", label: "Talare 1", displayName: "Anna Berg", needsConfirm: false },
  { elSessionId: "s1", speakerLabel: "1", label: "Talare 2", displayName: "Erik Lund", needsConfirm: false },
  { elSessionId: "s1", speakerLabel: "2", label: "Talare 3", displayName: "Sara Nyström", needsConfirm: true },
  { elSessionId: "s2", speakerLabel: "0", label: "Talare 4", displayName: null, needsConfirm: false },
];

/** "Uppgifter" (concrete tasks): one complete, two that lack something (fictional). */
const demoTasks: TaskView[] = [
  { id: "n3", text: "Boka Kårallen till hackathonet", owner: "Anna Berg", due: "fredag", doneWhen: "kontraktet är påskrivet", missing: [], locked: false },
  { id: "n5", text: "Fråga kåren om bidrag", owner: "Erik Lund", due: null, doneWhen: null, missing: ["due", "doneWhen"], locked: false },
  { id: "n7", text: "Sätta upp affischer", owner: null, due: "nästa vecka", doneWhen: null, missing: ["owner", "doneWhen"], locked: false },
];

const liveBase: LiveMeetingProps = {
  phase: "live",
  orgName: "Exempelföreningen",
  orgHref: "#",
  title: "Styrelsemöte, 24 nov",
  shareTranscript: true,
  startedAt: ago(42),
  elapsedMs: 42 * 60_000 + 10_000,
  docUrl: "https://docs.google.com/document/d/exempel/edit",
  lastUpdatedAt: ago(1),
  updatedMinutesAgo: 1,
  partialText: "och om vi tar femtio kronor i inträde så täcker det pizzan och lite till, men då måste vi fråga kåren först",
  partialSpeaker: "Erik Lund",
  connection: "ok",
  speakers,
  people,
  nameRound: [],
  onStart: noop,
  onPause: noop,
  onResume: noop,
  onStop: noop,
  onReLogin: noop,
  onAssignSpeaker: noop,
  onNameRoundDone: noop,
  onNameRoundSkip: noop,
  onResumeMeeting: noop,
  onEndUnfinished: noop,
  onRetry: noop,
  tasks: demoTasks,
  askTasks: async () => ({ tasks: demoTasks.filter((t) => t.missing.length > 0), owners: ["Anna Berg", "Erik Lund"], setAsking: async () => true }),
};

/** The protocol import's meeting list (fictional förening and titles). */
const demoImportFiles = {
  folders: 3,
  truncated: false,
  files: [
    { id: "1DemoDocAAAAAA1", name: "Styrelsemöte 2025-08-19", folderId: "f1", folderName: "Styrelsen", date: "2025-08-19", dateInferred: false, status: "imported" as const },
    { id: "1DemoDocAAAAAA2", name: "Protokoll styrelsemöte 2 sep 2025", folderId: "f1", folderName: "HT25", date: "2025-09-02", dateInferred: false, status: "ready" as const },
    { id: "1DemoDocAAAAAA3", name: "Styrelsemöte 250916", folderId: "f1", folderName: "HT25", date: "2025-09-16", dateInferred: false, status: "ready" as const },
    { id: "1DemoDocAAAAAA4", name: "Möte 7 okt", folderId: "f1", folderName: "HT25", date: "2025-10-07", dateInferred: true, status: "ready" as const },
    { id: "1DemoDocAAAAAA5", name: "Kallelse årsmöte 2026", folderId: "f1", folderName: "Styrelsen", date: "2025-10-20", dateInferred: true, status: "template" as const },
    { id: "1DemoDocAAAAAA6", name: "2025-11-04 18.00 Mötesprotokoll – Brädspelsföreningen Rutan", folderId: "f1", folderName: "Styrelsen", date: "2025-11-04", dateInferred: false, status: "own" as const },
    { id: "1DemoDocAAAAAA7", name: "Extra styrelsemöte 2025-11-18.docx", folderId: "f1", folderName: "HT25", date: "2025-11-18", dateInferred: false, status: "docx" as const },
  ],
};

/** The förening page on its Översikt tab (fictional data, overview-demo.ts). */
function OverviewDemo({ goalsPhase, overview = demoOverview, goals = demoGoals, historyCount }: { goalsPhase?: GoalsPhase; overview?: Overview; goals?: OverviewGoal[]; historyCount?: number }) {
  return (
    <AppChrome>
      <OrgDetailView
        org={org}
        isAdmin
        userId={ME}
        inviteUrl="https://simonsays.harrysson.co/join/Xk3fQ9pLm2"
        people={people}
        meetings={meetings}
        notice={null}
        startMeetingHref="#"
        tabs={{
          active: "oversikt",
          href: orgTabsHref,
          overview: <OverviewView orgId={ORG_ID} isAdmin overview={overview} goals={goals} historyCount={historyCount} initialGoalsPhase={goalsPhase} importAccess={{ driveReadonly: true, email: "kassor@rutan.example", meetingFolder: { id: "1DemoFolderAAAA", name: "Styrelsen" } }} now={OVERVIEW_NOW} />,
        }}
        actions={actions}
      />
    </AppChrome>
  );
}

function LiveDemo(overrides: Partial<LiveMeetingProps>) {
  return <InteractiveLive {...liveBase} {...overrides} />;
}

/** Live meeting with local state, so the speaker list and pause can be tried in the preview. */
function InteractiveLive(props: LiveMeetingProps) {
  const [phase, setPhase] = useState(props.phase);
  const [list, setList] = useState(props.speakers);
  return (
    <LiveMeeting
      {...props}
      phase={phase}
      speakers={list}
      onPause={() => setPhase("paused")}
      onResume={() => setPhase("live")}
      onStop={() => setPhase("ending")}
      onNameRoundDone={() => setPhase("live")}
      onNameRoundSkip={() => setPhase("live")}
      onAssignSpeaker={(key, choice) =>
        setList((all) =>
          all.map((s) =>
            s.elSessionId === key.elSessionId && s.speakerLabel === key.speakerLabel
              ? { ...s, displayName: choice.displayName, needsConfirm: false }
              : s,
          ),
        )
      }
    />
  );
}

/** Privat (0045): the consent step with the context picker instead of the agenda step. */
function PrivatConsentDemo({ contexts }: { contexts: { id: string; name: string }[] }) {
  const [ok, setOk] = useState(contexts.length > 0);
  return (
    <LiveDemo
      phase="consent"
      orgName="Privat"
      privat={{ summaryHref: null, backLabel: "Tillbaka till Privat" }}
      agendaConfirmed={ok}
      agenda={
        <ContextPicker
          contexts={contexts}
          initialId={contexts[0]?.id ?? null}
          create={async (name) => ({ ok: true, context: { id: `ny-${name}`, name } })}
          onChange={(choice) => setOk(choice !== null)}
        />
      }
    />
  );
}

/** Consent step: the tick starts the mic check, which "hears" something a moment later (open the settings to see it). */
function MicCheckDemo({ settingsOpen = false, silent = false }: { settingsOpen?: boolean; silent?: boolean }) {
  const [level, setLevel] = useState<number | null>(null);
  return (
    <LiveDemo
      phase="consent"
      settingsOpen={settingsOpen}
      micLevel={level}
      onMicCheck={() => {
        setLevel(0);
        if (!silent) setTimeout(() => setLevel(0.62), 900);
      }}
      onMicCheckStop={() => setLevel(null)}
      agenda={<AgendaDemoStep view={{ state: "none" }} />}
    />
  );
}

/** A video call on the start screen: the steps and Chrome's dialog, then the two meters (local state). */
function CallDemo({ initial = "none", support = "ok", foretag = false }: { initial?: "none" | "shared" | "no-audio"; support?: TabAudioSupport; foretag?: boolean }) {
  const [source, setSource] = useState<CaptureSource>("call");
  const [shared, setShared] = useState(initial === "shared");
  const [micOnly, setMicOnly] = useState(false);
  const [error, setError] = useState<CallShareError | null>(initial === "no-audio" ? "no-audio" : null);
  return (
    <LiveDemo
      phase="consent"
      agenda={<AgendaDemoStep view={{ state: "none" }} />}
      source={source}
      onSourceChange={setSource}
      foretag={foretag}
      callReady={support !== "ok" ? micOnly : shared}
      callHint={support !== "ok" ? "Välj Spela in med bara mikrofonen, eller öppna sidan i Chrome eller Edge." : undefined}
      callSetup={
        <CallSetup
          support={support}
          micOnly={micOnly}
          onMicOnly={() => setMicOnly(true)}
          shared={shared}
          sharing={false}
          error={error}
          levels={shared ? { mic: 0.42, call: 0.7 } : null}
          onShare={() => {
            setError(null);
            setShared(true);
          }}
        />
      }
    />
  );
}

const agendaFormats: AgendaFormatOption[] = [
  { id: "f1", kind: "veckomote", name: "Veckomöte", isDefault: true },
  { id: null, kind: "arsmote", name: "Årsmöte", isDefault: false },
  { id: null, kind: "enkel", name: "Enkel", isDefault: false },
];
const agendaGoals: GoalOption[] = [
  { id: "g2", label: "Mål: Ny lokal för styrelsen", reason: "Följ upp beslutet från förra veckan" },
  { id: "g1", label: "Mål: Fler medlemmar till vårens event", reason: "Inget nytt sedan 12 okt" },
];

/** The agenda step in one state, with local state; Använd / Välj / Skapa nytt dokument work locally (no Picker). */
function AgendaDemoStep({
  view,
  goals,
  initial = { kind: "new" },
  panelOpen,
  inFolder = true,
  eventTitle,
  onChosen,
}: {
  view: AgendaViewState;
  goals?: GoalOption[];
  initial?: AgendaStepViewProps["chosen"];
  panelOpen?: boolean;
  inFolder?: boolean;
  eventTitle?: string;
  onChosen?: (chosen: AgendaStepViewProps["chosen"], transcript: boolean) => void;
}) {
  const [chosen, setChosen] = useState<AgendaStepViewProps["chosen"]>(initial);
  const [formatValue, setFormatValue] = useState("id:f1");
  const [transcript, setTranscript] = useState(false);
  const [goalIds, setGoalIds] = useState<string[]>(goals ? [goals[0].id] : []);
  useEffect(() => onChosen?.(chosen, transcript), [chosen, transcript, onChosen]);
  return (
    <AgendaStepView
      view={view}
      formats={agendaFormats}
      formatValue={formatValue}
      chosen={chosen}
      offerTranscript
      transcriptInDoc={transcript}
      panelOpen={panelOpen}
      inFolder={inFolder && view.state !== "folder-unreachable"}
      eventTitle={eventTitle}
      onUseSuggestion={() => view.state === "suggestion" && setChosen({ kind: "agenda", name: view.suggestion.name })}
      onUsePrepared={() =>
        view.state === "prepared" && setChosen({ kind: "agenda", name: view.prepared.name, prepared: { date: view.prepared.date, kind: view.prepared.kind } })
      }
      onPickDoc={() => setChosen({ kind: "agenda", name: "Veckomöte 25/11" })}
      onUseFolder={() => setChosen({ kind: "agenda", name: "Veckomöte 25/11" })}
      onNewDoc={() => setChosen({ kind: "new" })}
      onFormatChange={setFormatValue}
      onTranscriptChange={setTranscript}
      goals={goals}
      goalIds={goalIds}
      onGoalChange={(id, on) => setGoalIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)))}
    />
  );
}

/** The consent step with the agenda step in one state. */
function AgendaDemo(props: Parameters<typeof AgendaDemoStep>[0]) {
  const [agendaDoc, setAgendaDoc] = useState<{ transcriptInDoc: boolean } | null>(null);
  const onChosen = useCallback(
    (chosen: AgendaStepViewProps["chosen"], transcript: boolean) => setAgendaDoc(chosen?.kind === "agenda" ? { transcriptInDoc: transcript } : null),
    [],
  );
  return <LiveDemo phase="consent" agenda={<AgendaDemoStep {...props} onChosen={onChosen} />} agendaDoc={agendaDoc} />;
}

/** A fictional Veckomöte draft: standing items, last week's open tasks, two recurring topics. */
const prepareDraft: DraftItem[] = [
  { id: "std:approve", label: "Godkänn dagordning", role: "procedural", source: "standing", on: true },
  { id: "std:checkin", label: "Må-runda", role: "checkin", source: "standing", on: true },
  {
    id: "std:followup",
    label: "Från förra veckan",
    role: "followup",
    source: "standing",
    on: true,
    origin: { kind: "meeting", date: "2026-11-24" },
    tasks: [
      { source: "m1:n2", line: "Erik Lund: Skicka kallelsen till medlemsmötet.", on: true },
      { source: "m1:n1", line: "Kassör: Boka Kårallen (fredag).", on: true },
      { source: "m1:n4", line: "Ordförande: Svara kåren om sponsringen.", on: true },
    ],
  },
  { id: "topic:sponsring", label: "Sponsring", role: "topic", source: "suggested", on: false, meetings: 4 },
  { id: "topic:hemsidan", label: "Hemsidan", role: "topic", source: "suggested", on: false, meetings: 2 },
  { id: "std:other", label: "Övrigt", role: "other", source: "standing", on: true, last: true },
];
// "Mål att ta upp" (todo #12): two approved goals with why Simon Says brings them up.
const goalMedlemmar: DraftItem = { id: "goal:fler medlemmar till vårens event", label: "Mål: Fler medlemmar till vårens event", role: "topic", source: "suggested", on: false, reason: "Inget nytt sedan 12 okt" };
const goalLokal: DraftItem = { id: "goal:ny lokal för styrelsen", label: "Mål: Ny lokal för styrelsen", role: "topic", source: "suggested", on: false, reason: "Följ upp beslutet från förra veckan" };
const prepareGoals: DraftItem[] = [...prepareDraft.slice(0, -1), goalLokal, goalMedlemmar, prepareDraft[prepareDraft.length - 1]];
const prepareGoalTicked: DraftItem[] = [...prepareDraft.slice(0, 3), { ...goalLokal, on: true }, ...prepareDraft.slice(3, -1), goalMedlemmar, prepareDraft[prepareDraft.length - 1]];
const prepareEdited: DraftItem[] = [
  prepareDraft[0],
  prepareDraft[1],
  { ...prepareDraft[2], tasks: prepareDraft[2].tasks!.map((t, i) => (i === 2 ? { ...t, on: false } : t)) },
  { ...prepareDraft[3], on: true },
  { id: "add:fest", label: "Fest på universitetet", role: "topic", source: "added", on: true },
  prepareDraft[4],
  prepareDraft[5],
];
const arsmoteDraft: DraftItem[] = [
  "Mötets öppnande",
  "Val av mötesordförande",
  "Val av mötessekreterare",
  "Val av justerare",
  "Fråga om mötet är stadgeenligt utlyst",
  "Verksamhetsberättelse",
  "Ekonomisk berättelse",
  "Revisionsberättelse",
  "Fråga om ansvarsfrihet för styrelsen",
  "Val av styrelse",
  "Motioner och propositioner",
].map((label, i) => ({ id: `std:${i}`, label, role: i < 5 ? ("procedural" as const) : ("other" as const), source: "standing" as const, on: true }));
const arsmoteLast: DraftItem[] = [
  { id: "std:other", label: "Övriga frågor", role: "other", source: "standing", on: true, last: true },
  { id: "std:close", label: "Mötets avslutande", role: "procedural", source: "standing", on: true, last: true },
];

function PrepareDemo({
  phase,
  items = prepareDraft,
  type = "veckomote",
  existing = null,
}: {
  phase: PreparePhase;
  items?: DraftItem[];
  type?: MeetingType;
  existing?: PrepareMeetingViewProps["existing"];
}) {
  const [state, setState] = useState(items);
  const [t, setT] = useState<MeetingType>(type);
  const [date, setDate] = useState("2026-12-01");
  const [time, setTime] = useState("18:00");
  let n = 0;
  return (
    <AppChrome>
      <PrepareMeetingView
        orgName="Exempelföreningen"
        orgHref="#"
        phase={phase}
        type={t}
        date={date}
        time={time}
        today="2026-11-26"
        items={state}
        existing={existing}
        onType={setT}
        onDate={setDate}
        onTime={setTime}
        onContinue={noop}
        onBack={noop}
        onItems={setState}
        onSave={noop}
        newId={() => `add:demo-${++n}-${state.length}`}
      />
    </AppChrome>
  );
}

function AppChrome({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader homeHref="#" nav={<AppNav email="anna.berg@example.com" signOut={noopAction} />} />
      <div className="flex-1 pt-8 pb-16">{children}</div>
    </>
  );
}

/** A learned proposal (fictional förening): no Må-runda, § numbering, signatures. */
const learnedProposal = {
  profile: {
    kind: "learned" as const,
    title: "Protokoll styrelsemöte",
    infoTable: ["Datum", "Plats", "Närvarande"],
    agendaHeading: "Dagordning",
    fixedAgendaItems: [
      { key: "open", label: "Mötets öppnande", role: "procedural" as const },
      { key: "previous", label: "Föregående protokoll", role: "followup" as const },
      { key: "other", label: "Övriga frågor", role: "other" as const, position: "last" as const },
      { key: "close", label: "Mötets avslutande", role: "procedural" as const, position: "last" as const },
    ],
    numbering: "paragraph" as const,
    tasksSection: { label: "Att göra", groupBy: "person" as const },
    notesSection: null,
    decisionPrefix: "Beslut:",
    taskStyle: "role-first" as const,
    tone: "full-sentences" as const,
    signatures: ["Mötesordförande", "Justerare"],
    requiredItems: [],
  },
  explanation:
    "Era protokoll börjar med en tabell med datum, plats och närvarande, följt av en dagordning numrerad med §. Mötet öppnas och avslutas alltid formellt, och uppgifterna samlas under Att göra.",
  qualityNote: "Uppgifterna saknar ofta ansvarig och datum. Simon Says skriver alltid ut båda, och varje beslut som en hel mening.",
  folderId: null,
};

function LearnDemo({ view, variant }: { view: LearnPhase; variant?: "learn" | "customize" }) {
  return (
    <AppChrome>
      <div className="mx-auto w-full max-w-page px-gutter">
        <Panel title="Mötesformat" titleId="format-title-demo">
          <LearnFormatView orgId={ORG_ID} view={view} variant={variant} onStart={noop} onCancel={noop} />
        </Panel>
      </div>
    </AppChrome>
  );
}

/** Mötesformat → "Lägg in årsmötet från stadgarna": the stadgar's årsmöte agenda to check (todo #15). */
function StadgarArsmoteDemo() {
  const [items, setItems] = useState(["Mötets öppnande", "Fråga om mötets behöriga utlysande", "Val av mötesordförande", "Verksamhetsberättelse", "Fråga om ansvarsfrihet för styrelsen", "Val av styrelse", "Val av revisorer"]);
  return <StadgarArsmote uid="demo-stadgar" stadgar={{ phase: "review", arsmote: items }} pickerEnabled onPick={noop} onChange={setItems} onSave={noop} onCancel={noop} />;
}

/** The format card alone, as wide as the förening page's main column. */
function FormatCardDemo(props: Omit<ComponentProps<typeof FormatCard>, "orgId">) {
  return (
    <AppChrome>
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="max-w-[47rem]">
          <FormatCard orgId={ORG_ID} {...props} />
        </div>
      </div>
    </AppChrome>
  );
}

const stadgarItems = ["Fråga om mötets behöriga utlysande", "Fråga om beslutsmässighet", "Ekonomisk rapport"];
const savedFormats: ComponentProps<typeof FormatCard>["formats"] = [
  { id: "f-stadgar", kind: "styrelseprotokoll", isDefault: true, createdAt: "2026-11-02T10:00:00Z", custom: true, requiredCount: 3 },
  { id: "f-learned", kind: "learned", isDefault: false, createdAt: "2026-10-14T10:00:00Z" },
];

function PublicChrome({ children, noLoginLink }: { children: ReactNode; noLoginLink?: boolean }) {
  return (
    <>
      <SiteHeader
        homeHref="#"
        nav={
          noLoginLink ? undefined : (
            <a className={navLinkClass} href="#">
              Logga in
            </a>
          )
        }
      />
      <div className="flex-1 pt-8 pb-16">{children}</div>
    </>
  );
}

/** The förening page's Inställningar, one section open (fictional data). */
function SettingsDemo({ section }: { section: SettingsSectionId }) {
  return (
    <AppChrome>
      <WithLocale
        render={(locale) => (
          <OrgDetailView
            org={{ ...org, ...orgProfile }}
            isAdmin
            userId={ME}
            inviteUrl="https://simonsays.harrysson.co/join/Xk3fQ9pLm2"
            members={adminMembers}
            people={people}
            meetings={meetings}
            notice={section === "styrelsen" ? orgNotice(undefined, "admin-ny", locale) : null}
            settingsSection={section}
            boardList={(memberControls, linkActions) => (
              <BoardStep
                orgName={org.name}
                rows={demoBoard}
                inviteUrl="https://simonsays.harrysson.co/join/Xk3fQ9pLm2"
                myEmail="anna.berg@example.com"
                memberControls={memberControls}
                linkActions={linkActions}
                inviteEmail={
                  <InviteByEmail
                    orgId={ORG_ID}
                    orgName={org.name}
                    inviterName="Anna Berg"
                    inviteUrl="https://simonsays.harrysson.co/join/Xk3fQ9pLm2"
                    invites={[]}
                    send={async () => ({ ok: true, results: [], invites: [] })}
                  />
                }
                onInvite={async () => null}
                onAdd={async () => null}
                onUpdate={async () => null}
                onRemove={async () => null}
              />
            )}
            detailsSettings={<OrgDetailsForm org={{ id: ORG_ID, name: org.name, logoUpdatedAt: null, profile: orgProfile }} />}
            folderSettings={<MeetingFolderSetting orgId={ORG_ID} folderName="Styrelsen 2026–2027" folderSet pickerEnabled />}
            calendarSettings={
              <OrgCalendarForm
                orgId={ORG_ID}
                connected
                calendars={[{ id: "kal-1", name: "Styrelsen" }, { id: "kal-2", name: "Föreningens möten" }]}
                current={{ id: "kal-1", name: "Styrelsen", filter: null }}
                save={async () => ({ ok: true })}
                connect={noopAction}
              />
            }
            voiceSettings={<VoicesSetting orgId={ORG_ID} board={demoBoard} />}
            summarySettings={<SummarySettingsDemo />}
            formatCard={<FormatCard orgId={ORG_ID} current={{ kind: "veckomote", name: "Veckomöte" }} isAdmin formats={[]} changeFormat={noopAction} />}
            startMeetingHref="#"
            tabs={{ active: "installningar", href: orgTabsHref }}
            actions={actions}
          />
        )}
      />
    </AppChrome>
  );
}

const meetings: OrgDetailViewProps["meetings"] = [
  { id: "m1", status: "live", started_at: ago(42), ended_at: null, doc_id: "exempel1", started_by: "other" },
  { id: "m2", status: "done", started_at: ago(7 * 24 * 60), ended_at: ago(7 * 24 * 60 - 84), doc_id: "exempel2", started_by: ME },
  { id: "m3", status: "abandoned", started_at: ago(14 * 24 * 60), ended_at: null, doc_id: "exempel3", started_by: "other" },
  { id: "m4", status: "done", started_at: ago(21 * 24 * 60), ended_at: ago(21 * 24 * 60 - 47), doc_id: "exempel4", started_by: "other" },
  { id: "m5", status: "done", started_at: ago(28 * 24 * 60), ended_at: ago(28 * 24 * 60 - 63), doc_id: "exempel5", started_by: ME },
  { id: "m6", status: "done", started_at: ago(35 * 24 * 60), ended_at: ago(35 * 24 * 60 - 55), doc_id: "exempel6", started_by: "other" },
  { id: "m7", status: "done", started_at: ago(42 * 24 * 60), ended_at: ago(42 * 24 * 60 - 71), doc_id: "exempel7", started_by: "other" },
  { id: "t1", status: "done", started_at: ago(3 * 24 * 60), ended_at: ago(3 * 24 * 60 - 4), doc_id: "exempel8", started_by: ME },
  { id: "t2", status: "done", started_at: ago(30 * 24 * 60), ended_at: ago(30 * 24 * 60 - 2), doc_id: "exempel9", started_by: ME },
];

/** Titles (calendar, final pass, agenda), Testmöten and counts; m7 is an old meeting: the date only. */
const meetingInfo: OrgDetailViewProps["meetingInfo"] = {
  m1: { title: "Styrelsemöte november", isTest: false, decisions: 0, tasks: 0 },
  m2: { title: "Budget och prova-på-kväll", isTest: false, decisions: 3, tasks: 5 },
  m3: { title: null, isTest: false, decisions: 0, tasks: 1 },
  m4: { title: "Lokalen och höstfesten", isTest: false, decisions: 1, tasks: 2 },
  m5: { title: "Ekonomi och spelkväll", isTest: false, decisions: 2, tasks: 0 },
  m6: { title: "Medlemsvärvning inför våren", isTest: false, decisions: 0, tasks: 3 },
  m7: { title: null, isTest: false, decisions: 1, tasks: 1 },
  t1: { title: "Testar mikrofonen", isTest: true, decisions: 0, tasks: 0 },
  t2: { title: null, isTest: true, decisions: 0, tasks: 0 },
};

const orgTabsHref = (t: OrgTab) => (t === "oversikt" ? "/design?vy=org-overview" : t === "installningar" ? "/design?vy=org-settings" : "/design?vy=org-admin");

const adminMembers: NonNullable<OrgDetailViewProps["members"]> = [
  { userId: ME, email: "anna.berg@example.com", role: "admin" },
  { userId: "00000000-0000-4000-8000-0000000000bb", email: "erik.lund@example.com", role: "member" },
  { userId: "00000000-0000-4000-8000-0000000000cc", email: "sara@example.com", role: "member" },
];

/** Inställningar's one board list: Kom igång's Styrelsen list with the members' account controls. */
const demoBoard: BoardRow[] = [
  { personId: "p1", name: "Anna Berg", role: "Ordförande", email: "anna.berg@example.com", status: "account", member: adminMembers[0], voiceConsent: false },
  { personId: "p2", name: "Erik Lund", role: "Kassör", email: "erik.lund@example.com", status: "account", member: adminMembers[1], voiceConsent: false },
  { personId: "p3", name: "Sara Nyström", role: "Sekreterare", email: "sara.n@example.com", status: "invited", member: null, voiceConsent: false },
  { personId: "p5", name: "Johan Ek", role: null, email: null, status: "name", member: null, voiceConsent: false },
  { personId: null, name: null, role: null, email: "sara@example.com", status: "account", member: adminMembers[2], voiceConsent: false },
];

/**
 * The Möten tab with the Nästa möte card in a given state (the weekly loop). Without `state` the
 * list decides: a live or ending meeting in it shows the card's running states.
 */
function HeroOrgDemo({
  state,
  list = meetings.slice(1),
  calendar,
  hero,
}: {
  state?: HeroState;
  list?: OrgDetailViewProps["meetings"];
  calendar?: NextMeetingHeroProps["calendar"];
  hero?: Partial<NextMeetingHeroProps>;
}) {
  return (
    <AppChrome>
      <OrgDetailView
        org={org}
        isAdmin
        userId={ME}
        inviteUrl="https://simonsays.harrysson.co/join/Xk3fQ9pLm2"
        members={adminMembers}
        people={people}
        meetings={list}
        meetingInfo={meetingInfo}
        notice={null}
        startMeeting={state && <NextMeetingHero orgId={ORG_ID} state={state} calendar={calendar} more={<MeetingMoreMenu orgId={ORG_ID} />} {...hero} />}
        liveMeetingHref={() => "/design?vy=live"}
        tabs={{ active: "moten", href: orgTabsHref }}
        actions={actions}
      />
    </AppChrome>
  );
}

const render: Record<string, () => ReactNode> = {
  tokens: () => <Tokens />,
  primitives: () => <Primitives />,
  login: () => (
    <PublicChrome noLoginLink>
      <LoginView next="/" signIn={noopAction} />
    </PublicChrome>
  ),
  "login-drive": () => (
    <PublicChrome noLoginLink>
      <LoginView next="/" error="drive" signIn={noopAction} />
    </PublicChrome>
  ),
  "login-kod": () => (
    <PublicChrome noLoginLink>
      <LoginView next="/join/abc" error="kod" signIn={noopAction} joining />
    </PublicChrome>
  ),
  "orgs-empty": () => (
    <AppChrome>
      <OrgsView orgs={[]} notice={null} createOrg={noopAction} />
    </AppChrome>
  ),
  orgs: () => (
    <AppChrome>
      <WithLocale
        render={(locale) => (
          <OrgsView
            orgs={[
              { id: ORG_ID, name: "Exempelföreningen", role: "admin" },
              { id: "o2", name: "Golfklubbens styrelse", role: "member" },
            ]}
            notice={orgsNotice("limit", undefined, locale)}
            createOrg={noopAction}
          />
        )}
      />
    </AppChrome>
  ),
  "org-admin": () => (
    <AppChrome>
      <WithLocale
        render={(locale) => (
          <OrgDetailView
            org={org}
            isAdmin
            userId={ME}
            inviteUrl="https://simonsays.harrysson.co/join/Xk3fQ9pLm2"
            members={[
              { userId: ME, email: "anna.berg@example.com", role: "admin" },
              { userId: "00000000-0000-4000-8000-0000000000bb", email: "erik.lund@example.com", role: "member" },
              { userId: "00000000-0000-4000-8000-0000000000cc", email: "sara@example.com", role: "member" },
            ]}
            people={people}
            meetings={meetings}
            notice={orgNotice("mote-active", undefined, locale)}
            summarySettings={<SummarySettingsDemo />}
            startMeetingHref="#"
            formatCard={
              <FormatCard
                orgId={ORG_ID}
                current={{ kind: "veckomote", name: "Veckomöte" }}
                isAdmin
                formats={[]}
                changeFormat={noopAction}
              />
            }
            liveMeetingHref={() => "/design?vy=live"}
            meetingInfo={meetingInfo}
            tabs={{ active: "moten", href: orgTabsHref }}
            actions={actions}
          />
        )}
      />
    </AppChrome>
  ),
  "org-settings": () => <SettingsDemo section="foreningen" />,
  "org-settings-styrelsen": () => <SettingsDemo section="styrelsen" />,
  "org-settings-moten": () => <SettingsDemo section="moten" />,
  "org-settings-efter": () => <SettingsDemo section="efter-motet" />,
  "org-settings-radera": () => <SettingsDemo section="radera" />,
  "org-member": () => (
    <AppChrome>
      <OrgDetailView
        org={org}
        isAdmin={false}
        userId={ME}
        inviteUrl="https://simonsays.harrysson.co/join/Xk3fQ9pLm2"
        members={[
          { userId: "00000000-0000-4000-8000-0000000000dd", email: "ordforande@example.com", role: "admin" },
          { userId: ME, email: "anna.berg@example.com", role: "member" },
        ]}
        people={people}
        meetings={meetings}
        meetingInfo={meetingInfo}
        notice={null}
        startMeetingHref="#"
        liveMeetingHref={() => "/design?vy=live"}
        tabs={{ active: "moten", href: (t) => (t === "oversikt" ? "/design?vy=org-overview" : "/design?vy=org-member") }}
        actions={actions}
      />
    </AppChrome>
  ),
  "org-member-about": () => (
    <AppChrome>
      <OrgDetailView
        org={{ ...org, ...orgProfile }}
        isAdmin={false}
        userId={ME}
        inviteUrl="https://simonsays.harrysson.co/join/Xk3fQ9pLm2"
        members={[
          { userId: "00000000-0000-4000-8000-0000000000dd", email: "ordforande@example.com", role: "admin" },
          { userId: ME, email: "anna.berg@example.com", role: "member" },
        ]}
        people={people}
        meetings={meetings}
        notice={null}
        startMeetingHref="#"
        actions={actions}
      />
    </AppChrome>
  ),
  "org-admins": () => (
    <AppChrome>
      <WithLocale
        render={(locale) => (
          <OrgDetailView
            org={org}
            isAdmin
            userId={ME}
            inviteUrl="https://simonsays.harrysson.co/join/Xk3fQ9pLm2"
            members={[
              { userId: ME, email: "anna.berg@example.com", role: "admin" },
              { userId: "00000000-0000-4000-8000-0000000000bb", email: "erik.lund@example.com", role: "admin" },
              { userId: "00000000-0000-4000-8000-0000000000cc", email: "sara@example.com", role: "member" },
            ]}
            people={people}
            meetings={[]}
            notice={orgNotice(undefined, "admin-ny", locale)}
            startMeetingHref="#"
            boardList={(memberControls, linkActions) => (
              <BoardStep
                orgName={org.name}
                rows={[
                  { ...demoBoard[0], member: { ...adminMembers[0] } },
                  { ...demoBoard[1], member: { ...adminMembers[1], role: "admin" } },
                  demoBoard[4],
                ]}
                inviteUrl="https://simonsays.harrysson.co/join/Xk3fQ9pLm2"
                myEmail="anna.berg@example.com"
                memberControls={memberControls}
                linkActions={linkActions}
                onAdd={async () => null}
                onUpdate={async () => null}
                onRemove={async () => null}
              />
            )}
            tabs={{ active: "installningar", href: orgTabsHref }}
            actions={actions}
          />
        )}
      />
    </AppChrome>
  ),
  "org-overview": () => <OverviewDemo />,
  "org-overview-goals": () => <OverviewDemo goalsPhase={{ phase: "editor", ...demoProposal }} />,
  "org-overview-import-access": () => <OverviewDemo goalsPhase={{ phase: "import", initial: { phase: "access" } }} />,
  "org-overview-import-declined": () => <OverviewDemo goalsPhase={{ phase: "import", initial: { phase: "access", consent: "nej" } }} />,
  "org-overview-import-files": () => (
    <OverviewDemo goalsPhase={{ phase: "import", initial: { phase: "files", folders: [{ id: "1DemoFolderAAAA", name: "Styrelsen" }], subfolders: true, initialFiles: demoImportFiles } }} />
  ),
  "org-overview-import-progress": () => <OverviewDemo goalsPhase={{ phase: "import", demoNow: IMPORT_DEMO_NOW, initial: { phase: "job", job: smallRunning, autoRun: true } }} />,
  "org-overview-import-paused": () => <OverviewDemo goalsPhase={{ phase: "import", demoNow: IMPORT_DEMO_NOW, initial: { phase: "job", job: smallRunning } }} />,
  "org-overview-import-failed": () => <OverviewDemo goalsPhase={{ phase: "import", demoNow: IMPORT_DEMO_NOW, initial: { phase: "job", job: smallFailed } }} />,
  "org-overview-import-batch-confirm": () => (
    <OverviewDemo
      goalsPhase={{
        phase: "import",
        initial: {
          phase: "confirm",
          files: demoImportFiles.files.map((f) => ({ id: f.id, name: f.name })),
          estimate: { docs: demoImportFiles.files.map((f) => ({ docId: f.id, sections: 24 })), protocols: 120, mode: "batch", importUsd: 1.92, digestUsd: 0.31, totalUsd: 2.23 },
          back: { phase: "picker" },
        },
      }}
    />
  ),
  "org-overview-import-batch-start": () => <OverviewDemo goalsPhase={{ phase: "import", demoNow: IMPORT_DEMO_NOW, initial: { phase: "job", job: largeStarted } }} />,
  "org-overview-import-batch-running": () => <OverviewDemo goalsPhase={{ phase: "import", demoNow: IMPORT_DEMO_NOW, initial: { phase: "job", job: largeRunning } }} />,
  "org-overview-import-batch-digesting": () => <OverviewDemo goalsPhase={{ phase: "import", demoNow: IMPORT_DEMO_NOW, initial: { phase: "job", job: largeDigesting } }} />,
  "org-overview-import-batch-done": () => <OverviewDemo goalsPhase={{ phase: "import", demoNow: IMPORT_DEMO_NOW, initial: { phase: "job", job: largeDone } }} />,
  "org-overview-limit": () => (
    <OverviewDemo goalsPhase={{ phase: "error", tone: "warning", message: "Du har bett om förslag tre gånger i dag. Försök igen i morgon." }} />
  ),
  "org-overview-history": () => <OverviewDemo overview={demoOverviewWithHistory} historyCount={48} />,
  "org-overview-history-only": () => <OverviewDemo overview={demoOverviewHistoryOnly} goals={[]} historyCount={48} />,
  "org-overview-empty": () => (
    <AppChrome>
      <OrgDetailView
        org={{ ...org, name: "Golfklubbens styrelse" }}
        isAdmin={false}
        userId={ME}
        inviteUrl="https://simonsays.harrysson.co/join/Pq7Rt2Vw9z"
        people={[]}
        meetings={[]}
        notice={null}
        tabs={{
          active: "oversikt",
          href: (t) => (t === "oversikt" ? "/design?vy=org-overview-empty" : "/design?vy=org-member-empty"),
          overview: <OverviewView orgId={ORG_ID} isAdmin={false} overview={emptyOverview} goals={[]} now={OVERVIEW_NOW} />,
        }}
        actions={actions}
      />
    </AppChrome>
  ),
  "format-card-admin": () => (
    <FormatCardDemo
      current={{ kind: "veckomote", name: "Veckomöte", id: null, profile: VECKOMOTE }}
      isAdmin
     
      formats={[]}
      changeFormat={noopAction}
      pickerEnabled
    />
  ),
  "format-card-full": () => (
    <FormatCardDemo
      current={{ kind: "styrelseprotokoll", name: "Styrelseprotokoll", id: "f-stadgar", profile: { ...STYRELSEPROTOKOLL, requiredItems: stadgarItems } }}
      isAdmin
     
      formats={savedFormats}
      changeFormat={noopAction}
      pickerEnabled
    />
  ),
  "format-card-picker-off": () => (
    <FormatCardDemo
      current={{ kind: "veckomote", name: "Veckomöte", id: null, profile: VECKOMOTE }}
      isAdmin
     
      formats={[]}
      changeFormat={noopAction}
    />
  ),
  "format-card-member": () => (
    <FormatCardDemo
      current={{ kind: "styrelseprotokoll", name: "Styrelseprotokoll", id: "f-stadgar", profile: { ...STYRELSEPROTOKOLL, requiredItems: stadgarItems } }}
      isAdmin={false}
     
      formats={savedFormats}
    />
  ),
  "format-learn-proposing": () => <LearnDemo view={{ phase: "proposing" }} />,
  "format-learn-editor": () => <LearnDemo view={{ phase: "editor", proposal: learnedProposal }} />,
  "format-learn-error": () => (
    <LearnDemo view={{ phase: "error", message: "Simon Says kan inte läsa ett av dokumenten. Välj dem igen i Google-väljaren." }} />
  ),
  "format-stadgar-arsmote": () => (
    <AppChrome>
      <div className="mx-auto w-full max-w-page px-gutter">
        <Panel title="Mötesformat" titleId="format-title-demo">
          <div className="flex flex-col gap-3">
            <StadgarLead />
            <StadgarArsmoteDemo />
          </div>
        </Panel>
      </div>
    </AppChrome>
  ),
  "org-prepared": () => (
    <HeroOrgDemo
      state={{ kind: "prepared", prepared: { date: "2026-12-01", time: "18:00", kind: "veckomote", docUrl: "https://docs.google.com/document/d/exempel/edit" }, event: null, day: { type: "weekday", weekday: 2 } }}
    />
  ),
  "org-start": () => <HeroOrgDemo state={{ kind: "unprepared", event: null, day: null }} />,
  "org-calendar": () => (
    <HeroOrgDemo
      state={{ kind: "unprepared", event: { id: "ev1", title: "Styrelsemöte", date: "2026-12-01", time: "18:00", now: false }, day: { type: "weekday", weekday: 2 } }}
      calendar={{ state: "ok", events: [{ id: "ev1", title: "Styrelsemöte", date: "2026-12-01", time: "18:00", now: false }] }}
    />
  ),
  "org-calendar-loading": () => <HeroOrgDemo state={{ kind: "unprepared", event: null, day: null }} calendar={{ state: "loading" }} />,
  "org-ending": () => (
    <HeroOrgDemo list={[{ ...meetings[0], status: "ending" }, ...meetings.slice(1)]} />
  ),
  "org-ended": () => (
    <HeroOrgDemo
      list={[{ ...meetings[1], started_at: ago(130), ended_at: ago(46) }, ...meetings.slice(2)]}
      state={{ kind: "ended", meetingId: "m2" }}
      hero={{ meeting: { id: "m2", title: "Budget och prova-på-kväll", startedAt: ago(130), endedAt: ago(46), decisions: 3, tasks: 5 }, summary: { state: "sent", sent: 3, mode: "missed" } }}
    />
  ),
  "org-ended-pending": () => (
    <HeroOrgDemo
      list={[{ ...meetings[1], started_at: ago(70), ended_at: ago(1) }, ...meetings.slice(2)]}
      state={{ kind: "ended", meetingId: "m2" }}
      hero={{ meeting: { id: "m2", title: null, startedAt: ago(70), endedAt: ago(1), decisions: 0, tasks: 2 }, summary: { state: "pending" } }}
    />
  ),
  "org-hero-foretag": () => (
    <AppChrome>
      <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-6 px-gutter">
        <NextMeetingHero orgId={ORG_ID} state={{ kind: "start" }} foretag />
      </div>
    </AppChrome>
  ),
  "prepare-type": () => <PrepareDemo phase={{ step: "type" }} />,
  "prepare-loading": () => <PrepareDemo phase={{ step: "loading" }} />,
  "prepare-draft": () => <PrepareDemo phase={{ step: "draft" }} />,
  "prepare-draft-import": () => (
    <PrepareDemo
      phase={{ step: "draft" }}
      items={prepareDraft.map((i) =>
        i.tasks
          ? {
              ...i,
              origin: { kind: "import", date: "2026-11-19" },
              tasks: [
                { source: "p1:h4", line: "Kassör: Beställa nya bollar.", on: true },
                { source: "p1:h7", line: "Ordförande: Boka banan till vårens första tävling.", on: true },
              ],
            }
          : i,
      )}
    />
  ),
  "prepare-draft-no-meeting": () => (
    <PrepareDemo phase={{ step: "draft" }} items={prepareDraft.map((i) => (i.tasks ? { ...i, origin: { kind: "none" }, tasks: [] } : i))} />
  ),
  "prepare-draft-too-old": () => (
    <PrepareDemo
      phase={{ step: "draft" }}
      items={prepareDraft.map((i) => (i.tasks ? { ...i, origin: { kind: "too_old", date: "2026-08-20" }, tasks: [] } : i))}
    />
  ),
  "prepare-draft-edited": () => <PrepareDemo phase={{ step: "draft" }} items={prepareEdited} />,
  "prepare-draft-goals": () => <PrepareDemo phase={{ step: "draft" }} items={prepareGoals} />,
  "prepare-draft-goal-added": () => <PrepareDemo phase={{ step: "draft" }} items={prepareGoalTicked} />,
  "prepare-draft-empty": () => <PrepareDemo phase={{ step: "draft" }} type="arsmote" items={[...arsmoteDraft, ...arsmoteLast]} />,
  "prepare-saving": () => <PrepareDemo phase={{ step: "draft", saving: true }} items={prepareEdited} />,
  "prepare-save-error": () => (
    <PrepareDemo phase={{ step: "draft", error: "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen." }} items={prepareEdited} />
  ),
  "prepare-again": () => (
    <PrepareDemo
      phase={{ step: "draft" }}
      items={prepareEdited}
      existing={{ docUrl: "https://docs.google.com/document/d/exempel/edit", docName: "2026-12-01 18.00 Dagordning – Exempelföreningen", updatedAt: "2026-11-26T10:00:00Z", held: false }}
    />
  ),
  "prepare-held": () => (
    <PrepareDemo
      phase={{ step: "draft" }}
      items={prepareEdited}
      existing={{ docUrl: "https://docs.google.com/document/d/exempel/edit", docName: "2026-12-01 18.00 Dagordning – Exempelföreningen", updatedAt: "2026-11-26T10:00:00Z", held: true }}
    />
  ),
  "prepare-done": () => (
    <PrepareDemo
      phase={{ step: "done", docUrl: "https://docs.google.com/document/d/exempel/edit", docName: "2026-12-01 18.00 Dagordning – Exempelföreningen", created: true, reordered: true }}
    />
  ),
  "prepare-done-merged": () => (
    <PrepareDemo
      phase={{ step: "done", docUrl: "https://docs.google.com/document/d/exempel/edit", docName: "2026-12-01 18.00 Dagordning – Exempelföreningen", created: false, reordered: false }}
    />
  ),
  "prepare-failed": () => <PrepareDemo phase={{ step: "failed", message: "Vi nådde inte Google just nu. Försök igen om en liten stund." }} />,
  "org-member-empty": () => (
    <AppChrome>
      <OrgDetailView
        org={{ ...org, name: "Golfklubbens styrelse" }}
        isAdmin={false}
        userId={ME}
        inviteUrl="https://simonsays.harrysson.co/join/Pq7Rt2Vw9z"
        members={[
          { userId: "00000000-0000-4000-8000-0000000000dd", email: "ordforande@example.com", role: "admin" },
          { userId: ME, email: "anna.berg@example.com", role: "member" },
        ]}
        people={[]}
        meetings={[]}
        notice={null}
        startMeetingHref="#"
        formatCard={
          <FormatCard
            orgId={ORG_ID}
            current={{ kind: "styrelseprotokoll", name: "Styrelseprotokoll" }}
            isAdmin={false}
           
            formats={[]}
          />
        }
        actions={actions}
      />
    </AppChrome>
  ),
  "join-out": () => (
    <PublicChrome>
      <JoinView state="signed-out" code="Xk3fQ9pLm2" signIn={noopAction} />
    </PublicChrome>
  ),
  "join-ready": () => (
    <PublicChrome>
      <JoinView state="ready" code="Xk3fQ9pLm2" orgName="Exempelföreningen" join={noopAction} />
    </PublicChrome>
  ),
  "join-invalid": () => (
    <PublicChrome>
      <JoinView state="invalid" />
    </PublicChrome>
  ),
  "whoami-pick": () => (
    <AppChrome>
      <WhoamiView orgId="o1" orgName="Exempelföreningen" people={WHOAMI_PEOPLE} adding={false} error={null} suggestedName="Sara Nyström" claim={noopAction} addSelf={noopAction} />
    </AppChrome>
  ),
  "whoami-add": () => (
    <AppChrome>
      <WhoamiView orgId="o1" orgName="Exempelföreningen" people={WHOAMI_PEOPLE} adding error="namn" suggestedName="" claim={noopAction} addSelf={noopAction} />
    </AppChrome>
  ),
  "whoami-none": () => (
    <AppChrome>
      <WhoamiView orgId="o1" orgName="Exempelföreningen" people={[]} adding={false} error={null} suggestedName="Sara Nyström" claim={noopAction} addSelf={noopAction} />
    </AppChrome>
  ),
  "org-welcome": () => (
    <AppChrome>
      <div className="mx-auto w-full max-w-[60rem] px-gutter pt-8">
        <WelcomeCard orgId="o1" orgName="Exempelföreningen" name="Sara Nyström" nextMeeting="tis 8 dec 18:00" />
      </div>
    </AppChrome>
  ),
  account: () => (
    <AppChrome>
      <AccountView
        email="anna.berg@example.com"
        signOut={noopAction}
        emailPrefs={{ allOff: false, off: ["invite"] }}
        saveEmailPrefs={fakeSave}
        saveLocale={noopAction}
      />
    </AppChrome>
  ),
  "account-mail-off": () => (
    <AppChrome>
      <AccountView
        email="anna.berg@example.com"
        signOut={noopAction}
        emailPrefs={{ allOff: true, off: ["invite"] }}
        saveEmailPrefs={fakeSave}
        saveLocale={noopAction}
      />
    </AppChrome>
  ),
  "account-mail-error": () => (
    <AppChrome>
      <AccountView email="anna.berg@example.com" signOut={noopAction} emailPrefs={null} saveEmailPrefs={fakeSave} saveLocale={noopAction} />
    </AppChrome>
  ),
  "account-mail-save-fails": () => (
    <AppChrome>
      <AccountView
        email="anna.berg@example.com"
        signOut={noopAction}
        emailPrefs={{ allOff: false, off: [] }}
        saveEmailPrefs={async () => false}
        saveLocale={noopAction}
      />
    </AppChrome>
  ),
  "mail-link": () => (
    <PublicChrome>
      <MailPrefsView
        state="ready"
        email="erik.lund@example.com"
        prefs={{ allOff: false, off: [] }}
        save={fakeSave}
        highlight="meeting_summary"
      />
    </PublicChrome>
  ),
  "mail-link-invalid": () => (
    <PublicChrome>
      <MailPrefsView state="invalid" />
    </PublicChrome>
  ),
  status: () => (
    <PublicChrome>
      <StatusView
        data={{
          health: "ok",
          liveCount: 2,
          liveMeetings: [
            { id: "l1", startedAt: ago(42), elapsedMs: 42 * 60_000, orgName: "Exempelföreningen" },
          ],
          meetingsThisWeek: 7,
          minutesThisWeek: 1284,
          updatedAt: ago(0),
        }}
      />
    </PublicChrome>
  ),
  "live-consent": () => <MicCheckDemo />,
  "live-consent-settings": () => <MicCheckDemo settingsOpen />,
  "live-consent-silent": () => <MicCheckDemo silent settingsOpen />,
  "live-call": () => <CallDemo />,
  "live-call-shared": () => <CallDemo initial="shared" />,
  "live-call-no-audio": () => <CallDemo initial="no-audio" />,
  "live-call-foretag": () => <CallDemo initial="shared" foretag />,
  "live-call-unsupported": () => <CallDemo support="browser" />,
  "live-mic-denied": () => <LiveDemo phase="consent" startError="mic-denied" agenda={<AgendaDemoStep view={{ state: "none" }} />} />,
  "live-agenda-loading": () => <AgendaDemo view={{ state: "loading" }} inFolder={false} />,
  "live-agenda-today": () => (
    <AgendaDemo
      view={{ state: "prepared", prepared: { docId: "d2", name: "2026-12-01 18.00 Dagordning – Exempelföreningen", date: "2026-11-26", time: "18:00", kind: "veckomote" as const, accessible: true } }}
      initial={{ kind: "agenda", name: "2026-11-26 18.00 Dagordning – Exempelföreningen", prepared: { date: "2026-11-26", kind: "veckomote" }, auto: true }}
    />
  ),
  "live-agenda-calendar": () => <AgendaDemo view={{ state: "none" }} eventTitle="Styrelsemöte vecka 48" />,
  "live-agenda-prepared": () => <AgendaDemo view={{ state: "prepared", prepared: { docId: "d2", name: "2026-12-01 18.00 Dagordning – Exempelföreningen", date: "2026-12-01", time: "18:00", kind: "veckomote" as const, accessible: true } }} />,
  "live-agenda-prepared-picker": () => <AgendaDemo view={{ state: "prepared", prepared: { docId: "d2", name: "2026-12-01 18.00 Dagordning – Exempelföreningen", date: "2026-12-01", time: "18:00", kind: "veckomote" as const, accessible: false } }} />,
  "live-agenda-suggestion": () => <AgendaDemo view={{ state: "suggestion", suggestion: { id: "d1", name: "Möte 25/11" } }} />,
  "live-agenda-none": () => <AgendaDemo view={{ state: "none" }} panelOpen />,
  "live-agenda-folder": () => <AgendaDemo view={{ state: "folder-unreachable", folderName: "Verksamhetsår 2026-2027" }} />,
  "live-agenda-off": () => <AgendaDemo view={{ state: "picker-off" }} inFolder={false} panelOpen />,
  "live-agenda-new-goals": () => <AgendaDemo view={{ state: "none" }} goals={agendaGoals} panelOpen />,
  "live-starting": () => <LiveDemo phase="starting" />,
  "live-nameround": () => (
    <LiveDemo
      phase="name-round"
      elapsedMs={48_000}
      lastUpdatedAt={null}
      partialText="jag heter Sara och jag är kassör"
      partialSpeaker={null}
      speakers={speakers.slice(0, 3)}
      nameRound={[
        { key: "a", label: "Talare 1", name: "Anna Berg", needsConfirm: false },
        { key: "b", label: "Talare 2", name: "Erik Lund", needsConfirm: false },
        { key: "c", label: "Talare 3", name: "Sara", needsConfirm: true },
      ]}
    />
  ),
  live: () => <LiveDemo />,
  "live-reconnecting": () => <LiveDemo connection="reconnecting" staleMinutes={4} lastUpdatedAt={ago(4)} updatedMinutesAgo={4} />,
  "live-doc-paused": () => <LiveDemo docPaused lastUpdatedAt={ago(6)} updatedMinutesAgo={6} />,
  "live-many-warnings": () => (
    <LiveDemo docPaused connection="offline" staleMinutes={5} minutesLeft={12} elapsedMs={(3 * 60 + 48) * 60_000} lastUpdatedAt={ago(5)} />
  ),
  "live-time-warning": () => <LiveDemo elapsedMs={(3 * 60 + 46) * 60_000} minutesLeft={14} />,
  "live-paused": () => <LiveDemo phase="paused" />,
  "live-error": () => <LiveDemo phase="error" connection="offline" />,
  "live-ending": () => <LiveDemo phase="ending" elapsedMs={84 * 60_000} />,
  "live-ended": () => <LiveDemo phase="ended" elapsedMs={84 * 60_000} />,
  "live-resume": () => <LiveDemo phase="resume" />,
  ...Object.fromEntries(Object.entries(onboardingRender).map(([id, view]) => [id, () => <AppChrome>{view()}</AppChrome>])),
  ...Object.fromEntries(
    Object.entries(summaryRender).map(([id, view]) => [id, () => <AppChrome>{view()}</AppChrome>]),
  ),
  ...Object.fromEntries(Object.entries(inviteRender).map(([id, view]) => [id, () => <AppChrome>{view()}</AppChrome>])),
  ...Object.fromEntries(Object.entries(homeRender).map(([id, view]) => [id, () => <AppChrome>{view()}</AppChrome>])),
  ...Object.fromEntries(Object.entries(privatRender).map(([id, view]) => [id, () => <AppChrome>{view()}</AppChrome>])),
  ...Object.fromEntries(Object.entries(briefRender).map(([id, view]) => [id, () => <AppChrome>{view()}</AppChrome>])),
  "live-privat-consent": () => <PrivatConsentDemo contexts={[{ id: "c1", name: "TDDE15" }, { id: "c2", name: "Exjobb" }, { id: "c3", name: "Övrigt" }]} />,
  "live-privat-first": () => <PrivatConsentDemo contexts={[]} />,
  "live-privat-ended": () => (
    <LiveDemo phase="ended" elapsedMs={52 * 60_000} docUrl={null} orgName="TDDE15" privat={{ summaryHref: "#", backLabel: "Tillbaka till TDDE15" }} />
  ),
};

export function DesignGallery({ view }: { view: string | null }) {
  if (view) return <>{render[view]()}</>;

  const groups = designViews.reduce<Record<DesignGroup, typeof designViews>>(
    (acc, v) => ({ ...acc, [v.group]: [...(acc[v.group] ?? []), v] }),
    {} as Record<DesignGroup, typeof designViews>,
  );

  return (
    <>
      <SiteHeader homeHref="/" />
      <main id="innehall" className="flex-1 pt-8 pb-16">
        <div className="mx-auto flex w-full max-w-page flex-col gap-4 px-gutter">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl wrap-anywhere">Designsystem</h1>
            <p className="max-w-[68ch] text-ink-2">
              Alla komponenter och alla lägen i appen, med påhittad data. Bara i utveckling (eller med DESIGN_PREVIEW=1).
              Öppna ett läge för sig med länken bredvid rubriken.
            </p>
          </div>
          <nav className="sticky top-16 z-10 flex flex-wrap gap-2 border-b border-line bg-board py-3 text-sm [&_a]:rounded-md [&_a]:bg-sunk [&_a]:px-[0.7rem] [&_a]:py-[0.3rem] [&_a]:text-ink-2 [&_a]:no-underline [&_a:hover]:text-ink" aria-label="Lägen">
            {designViews.map((v) => (
              <a key={v.id} href={`#${v.id}`}>
                {v.title}
              </a>
            ))}
          </nav>
          {(Object.keys(groups) as DesignGroup[]).map((group) => (
            <Fragment key={group}>
              <h2 className="mt-8 text-xl">
                {group}
              </h2>
              {groups[group].map((v) => (
                <section key={v.id} id={v.id} className="flex scroll-mt-28 flex-col gap-4 border-t border-line py-8" aria-labelledby={`${v.id}-h`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 id={`${v.id}-h`} className="text-lg tracking-[-0.02em]">
                      {v.title}
                    </h3>
                    <a className="text-sm text-ink-3" href={`/design?vy=${v.id}`}>
                      Öppna för sig
                    </a>
                  </div>
                  <div className="overflow-hidden rounded-lg bg-board shadow-[inset_0_0_0_1px_var(--line)]">{render[v.id]()}</div>
                </section>
              ))}
            </Fragment>
          ))}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

function Tokens() {
  const colors = [
    ["--board", "Bakgrund"],
    ["--surface", "Yta"],
    ["--surface-sunk", "Fördjupning"],
    ["--rail", "Kontrollkant"],
    ["--line", "Hårlinje"],
    ["--ink", "Text"],
    ["--ink-2", "Text 2"],
    ["--ink-3", "Text 3"],
    ["--blue", "Blå"],
    ["--green", "Grön"],
    ["--red", "Röd"],
    ["--amber", "Bärnsten"],
    ["--blue-wash", "Blå tvätt"],
    ["--green-wash", "Grön tvätt"],
    ["--red-wash", "Röd tvätt"],
    ["--amber-wash", "Bärnsten tvätt"],
  ];
  return (
    <div className="mx-auto flex w-full max-w-page flex-col gap-8 p-6">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
        {colors.map(([token, name]) => (
          <div key={token} className="flex flex-col gap-1 text-xs">
            <span className="h-14 rounded-md shadow-[inset_0_0_0_1px_var(--line)]" style={{ background: `var(${token})` }} />
            <strong>{name}</strong>
            <code>{token}</code>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <p className="text-display leading-[1.05] font-semibold tracking-[-0.045em]">
          Display 56
        </p>
        <p className="text-2xl font-semibold tracking-[-0.03em]">Rubrik 32 · Styrelsemöte</p>
        <p className="text-xl font-semibold tracking-[-0.025em]">Rubrik 24 · Personer</p>
        <p className="text-lg font-semibold">Rubrik 18 · Bjud in</p>
        <p>Brödtext 16 · Anteckningarna skrivs i ett nytt Google-dokument och delas med föreningen.</p>
        <p className="text-sm text-ink-3">Liten 14 · Uppdaterad 18:42</p>
        <p className="text-xs text-ink-3">Hjälptext 13 · Högst 100 tecken.</p>
        <p className="font-mono text-[1.75rem] tabular-nums">
          1:02:09 · Talare 2
        </p>
      </div>
    </div>
  );
}

function Primitives() {
  const [loading, setLoading] = useState(false);
  return (
    <div className="flex flex-col gap-8 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={<IconMic />}>
          Starta mötet
        </Button>
        <Button>Sekundär</Button>
        <Button variant="ghost">Avbryt</Button>
        <Button variant="danger" icon={<IconTrash size={18} />}>
          Radera
        </Button>
        <Button variant="danger-quiet">Ta bort</Button>
        <Button variant="primary" disabled>
          Inaktiv
        </Button>
        <Button
          variant="primary"
          loading={loading}
          onClick={() => {
            setLoading(true);
            setTimeout(() => setLoading(false), 1500);
          }}
        >
          {loading ? "Sparar…" : "Klicka för laddning"}
        </Button>
        <Button iconOnly icon={<IconPlus />}>
          Lägg till
        </Button>
        <ButtonLink href="#" size="sm" icon={<IconArrowRight size={16} />}>
          Länk som knapp
        </ButtonLink>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] items-start gap-6 max-[56rem]:grid-cols-[minmax(0,1fr)]">
        <div className="flex flex-col gap-8">
          <Field id="d-name" label="Namn" placeholder="t.ex. LiU AI Society" hint="Högst 100 tecken." />
          <Field id="d-err" label="Namn" defaultValue="" error="Ange ett namn (högst 100 tecken)." />
          <Field id="d-dis" label="Inaktivt fält" defaultValue="Går inte att ändra" disabled />
          <div className="flex flex-col gap-2">
            <Label htmlFor="d-select">Format</Label>
            <NativeSelect id="d-select" defaultValue="veckomote">
              <option value="veckomote">Veckomöte</option>
              <option value="styrelseprotokoll">Styrelseprotokoll</option>
            </NativeSelect>
          </div>
          <Check id="d-check" title="Dela transkriptionen i dokumentet" defaultChecked>
            Hela transkriptionen hamnar i en egen flik.
          </Check>
          <CopyField id="d-copy" value="https://simonsays.harrysson.co/join/Xk3fQ9pLm2" label="Inbjudningslänk" />
        </div>
        <div className="flex flex-col gap-8">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="live">Pågår</Badge>
            <Badge tone="success">Klart</Badge>
            <Badge tone="info">Admin</Badge>
            <Badge>Avbrutet</Badge>
          </div>
          <Banner tone="info" title="Info">
            Första anteckningarna kommer inom en minut.
          </Banner>
          <Banner tone="success">Föreningen är raderad.</Banner>
          <Banner tone="warning" title="Ansluter igen…">
            Ljudet sparas under tiden.
          </Banner>
          <Banner tone="danger" title="Inbjudningslänken gäller inte">
            Be om en ny länk.
          </Banner>
          <Banner tone="neutral" title="Anteckningarna har inte uppdaterats på 4 min" />
          <ConfirmAction
            action={noopAction}
            hidden={{}}
            trigger="Öppna bekräftelse"
            triggerVariant="secondary"
            triggerSize="md"
            title="Radera mötet?"
            description="Transkriptionen tas bort. Google-dokumentet ligger kvar i Drive."
            confirmLabel="Radera mötet"
          />
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] items-start gap-6 max-[56rem]:grid-cols-[minmax(0,1fr)]">
        <Panel flush title="Lista" titleId="d-list">
          <ul>
            <ListRow href="#" leading={<span className="grid size-9 flex-none place-items-center rounded-md bg-ink text-sm font-semibold text-on-ink">E</span>} title="Exempelföreningen" actions={<Badge tone="info">Admin</Badge>} />
            <ListRow title="Rad utan länk" meta="Metadata · 24 nov" />
          </ul>
        </Panel>
        <EmptyState title="Inga möten än" action={<Button size="sm">Gör något</Button>}>
          <p>Tom lista: en mening om varför, och vad man gör åt det.</p>
        </EmptyState>
      </div>
    </div>
  );
}
