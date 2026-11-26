"use client";

import { useRef, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { IconArrowLeft, IconPause } from "@/components/ui/icons";
import { liveStatus, type LiveStatus } from "@/lib/ui/live-status";
import { ConsentStep, type StartError } from "./ConsentStep";
import { DocLink } from "./DocLink";
import { LiveBanners } from "./LiveBanners";
import { LiveDialog } from "./LiveDialog";
import { MeetingControls } from "./MeetingControls";
import { MeetingEnded } from "./MeetingEnded";
import { MeetingTimer } from "./MeetingTimer";
import { NameRound, type NameRoundEntry } from "./NameRound";
import { PartialStrip } from "./PartialStrip";
import { ResumeMeeting } from "./ResumeMeeting";
import { SpeakerList } from "./SpeakerList";
import type { ConnectionState, LivePhase, PersonOption, Speaker, SpeakerChoice, SpeakerKey } from "./types";

export interface LiveMeetingProps {
  phase: LivePhase;
  orgName: string;
  /** Where "← Tillbaka" leads: the förening's page. */
  orgHref: string;
  /** Doc title, e.g. "Styrelsemöte, 24 nov". */
  title: string;
  shareTranscript: boolean;
  /** ISO start time (for resume and ended states). */
  startedAt?: string;
  elapsedMs: number;
  docUrl: string | null;
  lastUpdatedAt?: string | null;
  /** Whole minutes since `lastUpdatedAt` (the caller ticks it): "Uppdaterat för 2 min sedan". */
  updatedMinutesAgo?: number | null;
  partialText: string;
  partialSpeaker?: string | null;
  connection: ConnectionState;
  /** The page's first connection (not a reconnect): "Ansluter…". */
  firstConnect?: boolean;
  docPaused?: boolean;
  staleMinutes?: number | null;
  minutesLeft?: number | null;
  /** The cap behind `minutesLeft` or an automatic stop (heartbeat reason / refusal). */
  limitReason?: string | null;
  /** In phase "error": the stream's error kind and refusal code. */
  streamError?: string | null;
  refusal?: string | null;
  /** Members the Doc couldn't be shared with at start (null: unknown). */
  shareFailed?: number | null;
  /** After Avsluta: lines still waiting for the net. */
  pendingRuns?: number;
  /** After Avsluta: POST /end failed. */
  endFailed?: boolean;
  onRetryEnd?: () => void;
  /** After Avsluta while signed out: lines that need a new sign-in (null: not the case). */
  signedOutUnsent?: number | null;
  onEndWithoutUnsent?: () => void;
  /** While reconnecting: seconds until the next attempt. */
  retryInSeconds?: number | null;
  speakers: Speaker[];
  people: PersonOption[];
  nameRound: NameRoundEntry[];
  startError?: StartError;
  /** Replaces the start error's default explanation (e.g. the server's Swedish message). */
  startErrorText?: string | null;
  /** Consent step mic check: input level 0–1 while it runs (see ConsentStep). */
  micLevel?: number | null;
  onMicCheck?: () => void;
  /** Consent step: the agenda step (AgendaStep) and its state; see ConsentStep. */
  agenda?: ReactNode;
  agendaConfirmed?: boolean;
  agendaDoc?: { transcriptInDoc: boolean } | null;
  onNewDocInstead?: () => void;
  /** A control request is in flight. */
  busy?: boolean;
  autoStopped?: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onReLogin: () => void;
  onAssignSpeaker: (speaker: SpeakerKey, choice: SpeakerChoice) => void;
  onNameRoundDone: () => void;
  onNameRoundSkip?: () => void;
  /** "Klar" was pressed and the names are being read. */
  nameRoundBusy?: boolean;
  onResumeMeeting: () => void;
  onEndUnfinished?: () => void;
  onRetry: () => void;
  /** Leave the page (after confirming while running). Defaults to navigating to `orgHref`. */
  onLeave?: () => void;
  /** Something stuck that `liveStatus` doesn't cover (no mic sound, posts failing, signed out). */
  notice?: LiveNotice | null;
}

export interface LiveNotice {
  tone: "warning" | "danger";
  title: string;
  text: string;
  action?: { label: string; onClick: () => void };
}

/**
 * The whole live page as one presentational component: every phase and warning is a prop.
 * Task 7 owns the state machine (LiveStream, heartbeat, timers) and passes it in. The page is
 * full-screen focus mode: no app navigation, only "← Tillbaka".
 */
export function LiveMeeting(p: LiveMeetingProps) {
  const leave = p.onLeave ?? (() => window.location.assign(p.orgHref));

  if (p.phase === "consent" || p.phase === "starting") {
    return (
      <div className="live live--centered">
        <BackLink href={p.orgHref} label={p.orgName} />
        <ConsentStep
          orgName={p.orgName}
          shareTranscript={p.shareTranscript}
          onStart={p.onStart}
          starting={p.phase === "starting"}
          error={p.startError}
          errorText={p.startErrorText}
          micLevel={p.micLevel}
          onMicCheck={p.onMicCheck}
          agenda={p.agenda}
          agendaConfirmed={p.agendaConfirmed}
          agendaDoc={p.agendaDoc}
          onNewDocInstead={p.onNewDocInstead}
        />
        <PrivacyNote />
      </div>
    );
  }

  if (p.phase === "resume") {
    return (
      <div className="live live--centered">
        <BackLink href={p.orgHref} label={p.orgName} />
        <ResumeMeeting
          startedAt={p.startedAt ?? new Date().toISOString()}
          orgName={p.orgName}
          onResume={p.onResumeMeeting}
          onEnd={p.onEndUnfinished}
          resuming={p.busy}
          error={p.startError}
          errorText={p.startErrorText}
        />
      </div>
    );
  }

  if (p.phase === "ended") {
    return (
      <div className="live live--centered">
        <MeetingEnded
          docUrl={p.docUrl}
          durationSeconds={p.elapsedMs / 1000}
          orgHref={p.orgHref}
          autoStopped={p.autoStopped}
          stopReason={p.limitReason}
          shareFailed={p.shareFailed}
        />
      </div>
    );
  }

  const status = liveStatus(p);
  const ending = status.kind === "ending";
  const nameRound = p.phase === "name-round";

  return (
    <div className={`live live--${status.kind}`}>
      <BackLink href={p.orgHref} label={p.orgName} confirm={!ending} onLeave={leave} listening={status.kind === "live" || status.kind === "reconnecting"} />
      <header className={`livebar livebar--${status.kind}`}>
        <div className="livebar__who">
          <StatusHeadline status={status} />
          <div className="livebar__titles">
            <h1 className="livebar__title">{p.title}</h1>
            <span className="subtle">{p.orgName}</span>
          </div>
        </div>
        <MeetingTimer elapsedMs={p.elapsedMs} paused={status.kind !== "live"} size="md" />
        <MeetingControls
          status={ending ? "ending" : p.phase === "paused" ? "paused" : "live"}
          canPause={status.canPause}
          onPause={p.onPause}
          onResume={p.onResume}
          onStop={p.onStop}
          busy={p.busy}
        />
      </header>

      <LiveBanners
        banners={status.banners}
        connection={p.connection}
        minutesLeft={p.minutesLeft}
        limitReason={p.limitReason}
        retryInSeconds={p.retryInSeconds}
        streamError={p.streamError}
        refusal={p.refusal}
        onReLogin={p.onReLogin}
        onRetry={p.onRetry}
      />
      {p.notice && !ending && (
        <Banner
          tone={p.notice.tone}
          title={p.notice.title}
          action={
            p.notice.action && (
              <Button variant="primary" onClick={p.notice.action.onClick}>
                {p.notice.action.label}
              </Button>
            )
          }
        >
          {p.notice.text}
        </Banner>
      )}

      {ending ? (
        <MeetingEnded
          docUrl={p.docUrl}
          durationSeconds={p.elapsedMs / 1000}
          orgHref={p.orgHref}
          finalizing
          autoStopped={p.autoStopped}
          stopReason={p.limitReason}
          shareFailed={p.shareFailed}
          pendingRuns={p.pendingRuns}
          endFailed={p.endFailed}
          onRetryEnd={p.onRetryEnd}
          signedOutUnsent={p.signedOutUnsent}
          onReLogin={p.onReLogin}
          onEndWithoutUnsent={p.onEndWithoutUnsent}
          focusOnMount
        />
      ) : (
        <div className={`live__grid${nameRound ? " live__grid--single" : ""}`}>
          <div className="live__main">
            {nameRound && <NameRound entries={p.nameRound} onDone={p.onNameRoundDone} onSkip={p.onNameRoundSkip} busy={p.nameRoundBusy} />}
            <DocLink
              url={p.docUrl}
              title={p.title}
              lastUpdatedAt={p.lastUpdatedAt}
              updatedMinutesAgo={p.updatedMinutesAgo}
              health={status.doc}
            />
            <PartialStrip text={p.partialText} speaker={p.partialSpeaker} mode={status.partial} level={p.micLevel} />
          </div>
          {!nameRound && (
            <aside className="live__aside">
              <SpeakerList speakers={p.speakers} people={p.people} onAssign={p.onAssignSpeaker} />
            </aside>
          )}
        </div>
      )}
      <PrivacyNote />
    </div>
  );
}

/** The header's headline: is it recording? Readable from across the table. */
function StatusHeadline({ status }: { status: LiveStatus }) {
  return (
    <p className={`status-line status-line--${status.tone}`} role="status">
      <span className="status-line__main">
        {status.tone === "paused" && <IconPause size={20} className="status-line__icon" aria-hidden="true" />}
        <span className="status-line__label">{status.label}</span>
      </span>
      {status.detail && <span className="status-line__detail">— {status.detail}</span>}
    </p>
  );
}

/** "← Tillbaka". While the meeting runs it asks first, since leaving stops the listening. */
function BackLink({
  href,
  label,
  confirm,
  onLeave,
  listening,
}: {
  href: string;
  label: string;
  confirm?: boolean;
  onLeave?: () => void;
  /** Sound is (meant to be) going out right now: leaving stops it. */
  listening?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <a
        className="live__back"
        href={href}
        onClick={(event) => {
          if (!confirm) return;
          event.preventDefault();
          dialog.current?.showModal();
        }}
      >
        <IconArrowLeft size={18} aria-hidden="true" />
        <span className="visually-hidden">Tillbaka till </span>
        {label}
      </a>
      {confirm && (
        <LiveDialog
          ref={dialog}
          id="leave"
          title={listening ? "Mötet pågår — lämna sidan?" : "Mötet är inte avslutat — lämna sidan?"}
          stayLabel="Stanna kvar"
          confirmLabel="Lämna sidan"
          confirmVariant="secondary"
          stayVariant="primary"
          onConfirm={() => onLeave?.()}
        >
          {listening
            ? "Lämnar du sidan slutar laptopen lyssna, men mötet avslutas inte. Du kan fortsätta det från föreningens sida."
            : "Mötet avslutas inte när du lämnar sidan. Du kan fortsätta det, eller avsluta det, från föreningens sida."}
        </LiveDialog>
      )}
    </>
  );
}

function PrivacyNote() {
  return (
    <p className="subtle live__privacy">
      Ingen ljudinspelning sparas. Läs mer i <a href="/integritet">integritetsinformationen</a>.
    </p>
  );
}
