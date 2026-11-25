"use client";

import { Fragment, useState, type ReactNode } from "react";
import { LiveMeeting, type LiveMeetingProps } from "@/components/live/LiveMeeting";
import type { Speaker } from "@/components/live/types";
import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Check, Field } from "@/components/ui/Field";
import { IconArrowRight, IconMic, IconPlus, IconTrash } from "@/components/ui/icons";
import { ListRow } from "@/components/ui/ListRow";
import { Panel } from "@/components/ui/Panel";
import { SiteFooter } from "@/components/ui/SiteFooter";
import { SiteHeader } from "@/components/ui/SiteHeader";
import { AccountView } from "@/components/views/AccountView";
import { AppNav } from "@/components/views/AppNav";
import { JoinView } from "@/components/views/JoinView";
import { LoginView } from "@/components/views/LoginView";
import { OrgDetailView, type OrgDetailViewProps } from "@/components/views/OrgDetailView";
import { OrgsView } from "@/components/views/OrgsView";
import { StatusView } from "@/components/views/StatusView";
import { orgNotice, orgsNotice } from "@/lib/ui/messages";
import { designViews, type DesignGroup } from "./registry";

// Everything below is fake, illustrative data. No real people, orgs or ids.

const noop = () => {};
const noopAction = async () => {};
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
  rotateInvite: noopAction,
  addPerson: noopAction,
  renamePerson: noopAction,
  deletePerson: noopAction,
  deleteMeeting: noopAction,
  updateOrg: noopAction,
  deleteOrg: noopAction,
};

const org = { id: ORG_ID, name: "Exempelföreningen", share_transcript: true, show_on_status: false };

const speakers: Speaker[] = [
  { elSessionId: "s1", speakerLabel: "0", label: "Talare 1", displayName: "Anna Berg", needsConfirm: false },
  { elSessionId: "s1", speakerLabel: "1", label: "Talare 2", displayName: "Erik Lund", needsConfirm: false },
  { elSessionId: "s1", speakerLabel: "2", label: "Talare 3", displayName: "Sara Nyström", needsConfirm: true },
  { elSessionId: "s2", speakerLabel: "0", label: "Talare 4", displayName: null, needsConfirm: false },
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
};

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

/** Consent step with a mic check that "hears" something a moment after it is started. */
function MicCheckDemo() {
  const [level, setLevel] = useState<number | null>(null);
  return (
    <LiveDemo
      phase="consent"
      micLevel={level}
      onMicCheck={() => {
        setLevel(0);
        setTimeout(() => setLevel(0.62), 900);
      }}
    />
  );
}

function AppChrome({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader homeHref="#" nav={<AppNav email="anna.berg@example.com" signOut={noopAction} />} />
      <div className="main">{children}</div>
    </>
  );
}

function PublicChrome({ children, noLoginLink }: { children: ReactNode; noLoginLink?: boolean }) {
  return (
    <>
      <SiteHeader
        homeHref="#"
        nav={
          noLoginLink ? undefined : (
            <a className="nav-link" href="#">
              Logga in
            </a>
          )
        }
      />
      <div className="main">{children}</div>
    </>
  );
}

const meetings: OrgDetailViewProps["meetings"] = [
  { id: "m1", status: "live", started_at: ago(42), ended_at: null, doc_id: "exempel1", started_by: "other" },
  { id: "m2", status: "done", started_at: ago(7 * 24 * 60), ended_at: ago(7 * 24 * 60 - 84), doc_id: "exempel2", started_by: ME },
  { id: "m3", status: "abandoned", started_at: ago(14 * 24 * 60), ended_at: null, doc_id: "exempel3", started_by: "other" },
  { id: "m4", status: "done", started_at: ago(21 * 24 * 60), ended_at: ago(21 * 24 * 60 - 47), doc_id: "exempel4", started_by: "other" },
];

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
      <OrgsView
        orgs={[
          { id: ORG_ID, name: "Exempelföreningen", role: "admin" },
          { id: "o2", name: "Golfklubbens styrelse", role: "member" },
        ]}
        notice={orgsNotice("limit")}
        createOrg={noopAction}
      />
    </AppChrome>
  ),
  "org-admin": () => (
    <AppChrome>
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
        notice={orgNotice("mote-active")}
        startMeetingHref="#"
        liveMeetingHref={() => "/design?vy=live"}
        actions={actions}
      />
    </AppChrome>
  ),
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
  account: () => (
    <AppChrome>
      <AccountView email="anna.berg@example.com" userId={ME} signOut={noopAction} />
    </AppChrome>
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
  "live-mic-denied": () => <LiveDemo phase="consent" startError="mic-denied" />,
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
      <main id="innehall" className="main">
        <div className="page stack stack--4">
          <div className="stack stack--2">
            <h1 className="page-header__title">Designsystem</h1>
            <p className="muted measure">
              Alla komponenter och alla lägen i appen, med påhittad data. Bara i utveckling (eller med DESIGN_PREVIEW=1).
              Öppna ett läge för sig med länken bredvid rubriken.
            </p>
          </div>
          <nav className="design-toc toc" aria-label="Lägen">
            {designViews.map((v) => (
              <a key={v.id} href={`#${v.id}`}>
                {v.title}
              </a>
            ))}
          </nav>
          {(Object.keys(groups) as DesignGroup[]).map((group) => (
            <Fragment key={group}>
              <h2 className="section-title" style={{ marginTop: "2rem" }}>
                {group}
              </h2>
              {groups[group].map((v) => (
                <section key={v.id} id={v.id} className="design-section" aria-labelledby={`${v.id}-h`}>
                  <div className="cluster" style={{ justifyContent: "space-between" }}>
                    <h3 id={`${v.id}-h`} className="panel__title">
                      {v.title}
                    </h3>
                    <a className="subtle" href={`/design?vy=${v.id}`}>
                      Öppna för sig
                    </a>
                  </div>
                  <div className="design-frame">{render[v.id]()}</div>
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
    ["--board", "Tavlan"],
    ["--surface", "Ark"],
    ["--surface-sunk", "Fördjupning"],
    ["--rail", "Aluminium"],
    ["--line", "Linje"],
    ["--ink", "Svart penna"],
    ["--ink-2", "Text 2"],
    ["--ink-3", "Text 3"],
    ["--blue", "Blå penna"],
    ["--green", "Grön penna"],
    ["--red", "Röd penna"],
    ["--blue-wash", "Blå tvätt"],
    ["--green-wash", "Grön tvätt"],
    ["--red-wash", "Röd tvätt"],
  ];
  return (
    <div className="page stack stack--6" style={{ padding: "1.5rem" }}>
      <div className="design-swatches">
        {colors.map(([token, name]) => (
          <div key={token} className="swatch">
            <span className="swatch__chip" style={{ background: `var(${token})` }} />
            <strong>{name}</strong>
            <code>{token}</code>
          </div>
        ))}
      </div>
      <div className="stack stack--3">
        <p className="hero__title" style={{ fontSize: "var(--text-display)" }}>
          Display 64
        </p>
        <p style={{ fontSize: "var(--text-2xl)", fontWeight: 700, letterSpacing: "-0.02em" }}>Rubrik 34 · Styrelsemöte</p>
        <p style={{ fontSize: "var(--text-xl)", fontWeight: 700, letterSpacing: "-0.02em" }}>Rubrik 26 · Personer</p>
        <p style={{ fontSize: "var(--text-lg)", fontWeight: 700 }}>Rubrik 20 · Bjud in</p>
        <p>Brödtext 17 · Anteckningarna skrivs i ett nytt Google-dokument och delas med föreningen.</p>
        <p className="subtle">Liten 15 · Uppdaterad 18:42</p>
        <p className="hint">Hjälptext 13 · Högst 100 tecken.</p>
        <p className="mono" style={{ fontSize: "1.75rem" }}>
          1:02:09 · Talare 2
        </p>
      </div>
    </div>
  );
}

function Primitives() {
  const [loading, setLoading] = useState(false);
  return (
    <div className="stack stack--6" style={{ padding: "1.5rem" }}>
      <div className="cluster">
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

      <div className="org-grid">
        <div className="stack">
          <Field id="d-name" label="Namn" placeholder="t.ex. LiU AI Society" hint="Högst 100 tecken." />
          <Field id="d-err" label="Namn" defaultValue="" error="Ange ett namn (högst 100 tecken)." />
          <Field id="d-dis" label="Inaktivt fält" defaultValue="Går inte att ändra" disabled />
          <Check id="d-check" title="Dela transkriptionen i dokumentet" defaultChecked>
            Hela transkriptionen hamnar i en egen flik.
          </Check>
          <CopyField id="d-copy" value="https://simonsays.harrysson.co/join/Xk3fQ9pLm2" label="Inbjudningslänk" />
        </div>
        <div className="stack">
          <div className="cluster">
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

      <div className="org-grid">
        <Panel flush title="Lista" titleId="d-list">
          <ul className="list">
            <ListRow href="#" leading={<span className="org-initial">E</span>} title="Exempelföreningen" actions={<Badge tone="info">Admin</Badge>} />
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
