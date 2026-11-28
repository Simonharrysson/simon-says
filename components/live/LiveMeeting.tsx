"use client";

import { useLocale, useTranslations } from "next-intl";

import { useRef, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { IconArrowLeft, IconPause } from "@/components/ui/icons";
import { liveStatus, type LiveStatus } from "@/lib/ui/live-status";
import { cn } from "@/lib/utils";
import type { CaptureSource } from "@/lib/audio/call";
import { ConsentStep, type StartError } from "./ConsentStep";
import { DocLink } from "./DocLink";
import { LiveBanners } from "./LiveBanners";
import { LiveDialog, type LiveDialogHandle } from "./LiveDialog";
import { MeetingControls } from "./MeetingControls";
import { MeetingEnded } from "./MeetingEnded";
import { MeetingTimer } from "./MeetingTimer";
import { NameRound, type NameRoundEntry } from "./NameRound";
import { PartialStrip } from "./PartialStrip";
import { ResumeMeeting } from "./ResumeMeeting";
import { SpeakerList } from "./SpeakerList";
import { TasksPanel } from "./TasksPanel";
import type { EndStats, TaskAnswer, TaskView } from "@/lib/notes/tasks";
import type { EndAsk } from "./EndTasksDialog";
import type { ConnectionState, LivePhase, PersonOption, Speaker, SpeakerChoice, SpeakerKey } from "./types";

export interface LiveMeetingProps {
  /** A Privat recording (0045): Privat copy on the consent and ended screens; the summary's page. */
  privat?: { summaryHref: string | null; backLabel: string } | null;
  phase: LivePhase;
  orgName: string;
  /** Where "← Tillbaka" leads: the förening's page. */
  orgHref: string;
  /** The meeting's page in the app, linked from the ended screen (förening meetings). */
  meetingHref?: string | null;
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
  /** 0070: paused because the förening's Drive account needs renewing: no "Logga in igen". */
  docPausedForening?: boolean;
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
  /** Consent step: the consent was unticked, let go of the mic. */
  onMicCheckStop?: () => void;
  /** /design: "Inställningar för mötet" open. */
  settingsOpen?: boolean;
  /** Consent step: the agenda step (AgendaStep) and its state; see ConsentStep. */
  agenda?: ReactNode;
  agendaConfirmed?: boolean;
  agendaDoc?: { transcriptInDoc: boolean } | null;
  onNewDocInstead?: () => void;
  /** Consent step: the calendar event it was started from (todo #14). */
  eventTitle?: string | null;
  /** Consent step: "Var hålls mötet?" and the video-call steps; see ConsentStep. */
  source?: CaptureSource;
  onSourceChange?: (s: CaptureSource) => void;
  foretag?: boolean;
  /** Consent step, a förening only: the growth loop's per-meeting toggle (0067); see ConsentStep. */
  inviteGuests?: { on: boolean; onChange: (on: boolean) => void };
  callSetup?: ReactNode;
  callReady?: boolean;
  callHint?: string;
  /** Resume: the meeting is a video call (the share picker opens again). */
  resumeCall?: boolean;
  /** A control request is in flight. */
  busy?: boolean;
  autoStopped?: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: (answers?: TaskAnswer[], stats?: EndStats) => void;
  /** The Avsluta answers arrived after the meeting had already ended elsewhere: not saved. */
  answersLost?: boolean;
  /** This meeting's tasks ("Uppgifter"); undefined: not loaded yet (no panel). */
  tasks?: TaskView[];
  /** Avsluta asks about these first (the förening requires Vem, När, Klart när). */
  askTasks?: () => Promise<EndAsk>;
  onReLogin: () => void;
  onAssignSpeaker: (speaker: SpeakerKey, choice: SpeakerChoice) => void;
  onNameRoundDone: () => void;
  onNameRoundSkip?: () => void;
  /** "Klar" was pressed and the names are being read. */
  nameRoundBusy?: boolean;
  onResumeMeeting: () => void;
  /** Resume screen: another tab is recording the meeting right now ("Ta över här"). */
  connectedElsewhere?: boolean;
  /** Resume screen: the meeting is still live (not abandoned). */
  resumeLive?: boolean;
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
  const locale = useLocale();
  const leave = p.onLeave ?? (() => window.location.assign(p.orgHref));

  if (p.phase === "consent" || p.phase === "starting") {
    return (
      <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-6 px-gutter pt-[clamp(1.5rem,8vh,5rem)] pb-12">
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
          onMicCheckStop={p.onMicCheckStop}
          settingsOpen={p.settingsOpen}
          agenda={p.agenda}
          agendaConfirmed={p.agendaConfirmed}
          agendaDoc={p.agendaDoc}
          onNewDocInstead={p.onNewDocInstead}
          eventTitle={p.eventTitle}
          privat={Boolean(p.privat)}
          source={p.source}
          onSourceChange={p.onSourceChange}
          foretag={p.foretag}
          callSetup={p.callSetup}
          callReady={p.callReady}
          callHint={p.callHint}
          inviteGuests={p.inviteGuests}
        />
        <PrivacyNote />
      </div>
    );
  }

  if (p.phase === "resume") {
    return (
      <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-6 px-gutter pt-[clamp(1.5rem,8vh,5rem)] pb-12">
        <BackLink href={p.orgHref} label={p.orgName} />
        <ResumeMeeting
          startedAt={p.startedAt ?? new Date().toISOString()}
          orgName={p.orgName}
          onResume={p.onResumeMeeting}
          connectedElsewhere={p.connectedElsewhere}
          live={p.resumeLive ?? true}
          onEnd={p.onEndUnfinished}
          resuming={p.busy}
          error={p.startError}
          errorText={p.startErrorText}
          callHint={p.resumeCall}
        />
      </div>
    );
  }

  if (p.phase === "ended") {
    return (
      <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-6 px-gutter pt-[clamp(1.5rem,8vh,5rem)] pb-12">
        <MeetingEnded
          answersLost={p.answersLost}
          docUrl={p.docUrl}
          durationSeconds={p.elapsedMs / 1000}
          orgHref={p.orgHref}
          meetingHref={p.meetingHref}
          autoStopped={p.autoStopped}
          stopReason={p.limitReason}
          shareFailed={p.privat ? null : p.shareFailed}
          privat={p.privat}
        />
      </div>
    );
  }

  const status = liveStatus(p, locale);
  const ending = status.kind === "ending";
  const nameRound = p.phase === "name-round";

  return (
    <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-gutter pt-6 pb-12" data-status={status.kind}>
      <BackLink href={p.orgHref} label={p.orgName} confirm={!ending} onLeave={leave} listening={status.kind === "live" || status.kind === "reconnecting"} privat={Boolean(p.privat)} />
      <header
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-6 rounded-lg bg-surface px-6 py-4 shadow-panel transition-colors duration-200 ease-out max-[52rem]:grid-cols-[minmax(0,1fr)_auto] max-[52rem]:gap-4",
          // Paused (and stopped): the whole bar goes flat grey, visible even in peripheral vision.
          status.kind === "paused" && "bg-sunk shadow-[inset_0_0_0_1px_var(--rail)]",
          status.kind === "error" && "bg-sunk shadow-[inset_0_0_0_1px_var(--red)]",
        )}
      >
        <div className="flex min-w-0 flex-col items-start gap-2">
          <StatusHeadline status={status} />
          <div className="flex max-w-full min-w-0 flex-col">
            <h1 className="truncate text-base">{p.title}</h1>
            <span className="text-sm text-ink-3">{p.orgName}</span>
          </div>
        </div>
        <MeetingTimer elapsedMs={p.elapsedMs} paused={status.kind !== "live"} size="md" />
        <MeetingControls
          status={ending ? "ending" : p.phase === "paused" ? "paused" : "live"}
          canPause={status.canPause}
          onPause={p.onPause}
          onResume={p.onResume}
          onStop={p.onStop}
          askTasks={p.askTasks}
          busy={p.busy}
          className="max-[52rem]:col-span-full"
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
        onReLogin={p.docPausedForening ? undefined : p.onReLogin}
        onRetry={p.onRetry}
        docPausedForening={p.docPausedForening}
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
          answersLost={p.answersLost}
          docUrl={p.docUrl}
          durationSeconds={p.elapsedMs / 1000}
          orgHref={p.orgHref}
          finalizing
          autoStopped={p.autoStopped}
          stopReason={p.limitReason}
          shareFailed={p.privat ? null : p.shareFailed}
          privat={p.privat}
          pendingRuns={p.pendingRuns}
          endFailed={p.endFailed}
          onRetryEnd={p.onRetryEnd}
          signedOutUnsent={p.signedOutUnsent}
          onReLogin={p.onReLogin}
          onEndWithoutUnsent={p.onEndWithoutUnsent}
          focusOnMount
        />
      ) : (
        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] items-start gap-6 max-[52rem]:grid-cols-[minmax(0,1fr)]",
            nameRound && "grid-cols-[minmax(0,1fr)]",
          )}
        >
          <div className="flex min-w-0 flex-col gap-4">
            {nameRound && <NameRound entries={p.nameRound} onDone={p.onNameRoundDone} onSkip={p.onNameRoundSkip} busy={p.nameRoundBusy} />}
            <DocLink
              url={p.docUrl}
              title={p.title}
              lastUpdatedAt={p.lastUpdatedAt}
              updatedMinutesAgo={p.updatedMinutesAgo}
              health={status.doc}
              pausedForening={p.docPausedForening}
            />
            <PartialStrip text={p.partialText} speaker={p.partialSpeaker} mode={status.partial} level={p.micLevel} />
          </div>
          {!nameRound && (
            <aside className="flex flex-col gap-6">
              <SpeakerList speakers={p.speakers} people={p.people} onAssign={p.onAssignSpeaker} />
              {p.tasks && <TasksPanel tasks={p.tasks} />}
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
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-3 text-xl leading-[1.15] font-semibold tracking-[-0.03em] max-[30rem]:text-lg",
        status.tone === "live" && "text-red",
        status.tone === "paused" && "text-ink",
        status.tone === "waiting" && "text-ink-2",
        status.tone === "alert" && "text-red",
      )}
      role="status"
    >
      <span className="inline-flex items-center gap-3 whitespace-nowrap">
        {status.tone === "paused" && <IconPause size={20} aria-hidden="true" />}
        <span>{status.label}</span>
      </span>
      {status.detail && <span className="text-base font-medium tracking-normal text-ink-2 max-[30rem]:basis-full max-[30rem]:text-sm">— {status.detail}</span>}
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
  privat,
}: {
  href: string;
  label: string;
  confirm?: boolean;
  onLeave?: () => void;
  /** Sound is (meant to be) going out right now: leaving stops it. */
  listening?: boolean;
  /** Privat (0045): "continue it from Privat", not from the förening's page. */
  privat?: boolean;
}) {
  const t = useTranslations("live.meeting");
  const tp = useTranslations("privat.live");
  const dialog = useRef<LiveDialogHandle>(null);
  return (
    <>
      <a
        className="-mt-3 -mb-2 -ml-2 inline-flex min-h-11 items-center gap-2 self-start rounded-md px-2 text-sm font-semibold text-ink-2 no-underline hover:bg-sunk hover:text-ink hover:no-underline"
        href={href}
        onClick={(event) => {
          if (!confirm) return;
          event.preventDefault();
          dialog.current?.showModal();
        }}
      >
        <IconArrowLeft size={18} aria-hidden="true" />
        <span className="sr-only">{t("backTo")}</span>
        {label}
      </a>
      {confirm && (
        <LiveDialog
          ref={dialog}
          id="leave"
          title={listening ? t("leaveLive") : t("leaveNotEnded")}
          stayLabel={t("stay")}
          confirmLabel={t("leave")}
          confirmVariant="secondary"
          stayVariant="primary"
          onConfirm={() => onLeave?.()}
        >
          {privat ? (listening ? tp("leaveLiveText") : tp("leaveText")) : listening ? t("leaveLiveText") : t("leaveText")}
        </LiveDialog>
      )}
    </>
  );
}

function PrivacyNote() {
  const t = useTranslations("live.meeting");
  return (
    <p className="mt-4 text-center text-sm text-ink-3">{t.rich("privacy", { link: (chunks) => <a href="/integritet">{chunks}</a> })}</p>
  );
}
