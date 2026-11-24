"use client";

import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { IconRefresh } from "@/components/ui/icons";
import { ConsentStep, type StartError } from "./ConsentStep";
import { DocLink } from "./DocLink";
import { LiveBanners } from "./LiveBanners";
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
  orgHref: string;
  /** Doc title, e.g. "Styrelsemöte, 24 nov". */
  title: string;
  shareTranscript: boolean;
  /** ISO start time (for resume and ended states). */
  startedAt?: string;
  elapsedMs: number;
  docUrl: string | null;
  lastUpdatedAt?: string | null;
  partialText: string;
  partialSpeaker?: string | null;
  connection: ConnectionState;
  docPaused?: boolean;
  staleMinutes?: number | null;
  minutesLeft?: number | null;
  speakers: Speaker[];
  people: PersonOption[];
  nameRound: NameRoundEntry[];
  startError?: StartError;
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
  onResumeMeeting: () => void;
  onEndUnfinished?: () => void;
  onRetry: () => void;
}

/**
 * The whole live page as one presentational component: every phase and warning is a prop.
 * Task 7 owns the state machine (LiveStream, heartbeat, timers) and passes it in.
 */
export function LiveMeeting(p: LiveMeetingProps) {
  if (p.phase === "consent" || p.phase === "starting") {
    return (
      <div className="live live--centered">
        <ConsentStep
          orgName={p.orgName}
          shareTranscript={p.shareTranscript}
          onStart={p.onStart}
          starting={p.phase === "starting"}
          error={p.startError}
        />
        <PrivacyNote />
      </div>
    );
  }

  if (p.phase === "resume") {
    return (
      <div className="live live--centered">
        <ResumeMeeting
          startedAt={p.startedAt ?? new Date().toISOString()}
          orgName={p.orgName}
          onResume={p.onResumeMeeting}
          onEnd={p.onEndUnfinished}
          resuming={p.busy}
        />
      </div>
    );
  }

  if (p.phase === "ended") {
    return (
      <div className="live live--centered">
        <MeetingEnded docUrl={p.docUrl} durationSeconds={p.elapsedMs / 1000} orgHref={p.orgHref} autoStopped={p.autoStopped} />
      </div>
    );
  }

  const paused = p.phase === "paused";
  const ending = p.phase === "ending";
  const status = ending ? "ending" : paused ? "paused" : "live";

  return (
    <div className="live">
      <header className="livebar">
        <div className="livebar__who">
          {paused ? (
            <Badge>Pausat</Badge>
          ) : ending ? (
            <Badge>Avslutar</Badge>
          ) : p.phase === "error" ? (
            <Badge>Stannat</Badge>
          ) : (
            <Badge tone="live">Transkriberar</Badge>
          )}
          <div className="livebar__titles">
            <h1 className="livebar__title">{p.title}</h1>
            <span className="subtle">{p.orgName}</span>
          </div>
        </div>
        <MeetingTimer elapsedMs={p.elapsedMs} paused={paused || p.phase === "error"} />
        <MeetingControls status={status} onPause={p.onPause} onResume={p.onResume} onStop={p.onStop} busy={p.busy} />
      </header>

      {p.phase === "error" && (
        <Banner
          tone="danger"
          title="Transkriptionen har stannat"
          action={
            <Button variant="primary" size="sm" icon={<IconRefresh size={16} />} onClick={p.onRetry}>
              Försök igen
            </Button>
          }
        >
          Vi fick ingen kontakt med transkriberingen efter tre försök. Det som redan sagts finns kvar i dokumentet.
        </Banner>
      )}

      <LiveBanners
        connection={p.connection}
        docPaused={p.docPaused}
        staleMinutes={p.staleMinutes}
        minutesLeft={p.minutesLeft}
        onReLogin={p.onReLogin}
      />

      {ending && (
        <MeetingEnded docUrl={p.docUrl} durationSeconds={p.elapsedMs / 1000} orgHref={p.orgHref} finalizing autoStopped={p.autoStopped} />
      )}

      {!ending && (
        <div className="live__grid">
          <div className="live__main">
            {p.phase === "name-round" && (
              <NameRound entries={p.nameRound} onDone={p.onNameRoundDone} onSkip={p.onNameRoundSkip} />
            )}
            <PartialStrip text={p.partialText} speaker={p.partialSpeaker} paused={paused} listening={p.phase !== "error"} />
            <DocLink url={p.docUrl} title={p.title} lastUpdatedAt={p.lastUpdatedAt} />
          </div>
          <aside className="live__aside">
            <SpeakerList speakers={p.speakers} people={p.people} onAssign={p.onAssignSpeaker} />
          </aside>
        </div>
      )}
      <PrivacyNote />
    </div>
  );
}

function PrivacyNote() {
  return (
    <p className="subtle live__privacy">
      Ingen ljudinspelning sparas. Läs mer i <a href="/integritet">integritetsinformationen</a>.
    </p>
  );
}
