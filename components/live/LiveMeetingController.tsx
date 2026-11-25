"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MicCapture } from "@/lib/audio/capture";
import { LiveStream, type HeartbeatInfo, type StreamHealth, type StreamStatus } from "@/lib/audio/stream";
import type { StartError } from "./ConsentStep";
import { LiveMeeting, type LiveNotice } from "./LiveMeeting";
import type { ConnectionState, LivePhase } from "./types";

/** Notes count as stale when runs posted this long ago have not reached the Doc yet. */
const STALE_AFTER_MS = 3 * 60_000;
/** How often the page re-reads the meeting while the final pass runs elsewhere. */
const ENDING_POLL_MS = 5000;

export interface LiveMeetingInfo {
  id: string;
  status: "live" | "ending" | "done" | "abandoned";
  startedAt: string;
  docUrl: string;
  title: string;
  /** The server's open (or last) ElevenLabs session: passed as closingSessionId on resume. */
  currentElSessionId: string | null;
  /** live, or abandoned < 2 h ago: offer "Fortsätt mötet". */
  resumable: boolean;
  lastTickOkAt: string | null;
  docPaused: boolean;
  /** Seconds the meeting lasted, for an ended meeting. */
  durationSeconds?: number;
}

export interface LiveMeetingControllerProps {
  orgId: string;
  orgName: string;
  orgHref: string;
  shareTranscript: boolean;
  /** null: a new meeting (consent step first). */
  meeting: LiveMeetingInfo | null;
  /** The meeting was stopped by a limit (4 h, caps), not by a person (`?stoppat=1`). */
  autoStopped?: boolean;
}

function initialPhase(m: LiveMeetingInfo | null): LivePhase {
  if (!m) return "consent";
  if (m.status === "ending") return "ending";
  if (m.resumable) return "resume";
  return "ended";
}

const RUNNING: LivePhase[] = ["starting", "live", "paused", "name-round", "error"];

/**
 * The live page's state machine: mic (MicCapture) → LiveStream → the presentational
 * LiveMeeting. New meeting: consent → Start (mic first, from the click, then POST /api/meetings
 * creates the Doc) → live. Reopened meeting: "Fortsätt mötet" (also a click, so the mic and
 * Safari's audio may start). Stopp: LiveStream drains and posts, then POST /end.
 */
export function LiveMeetingController(props: LiveMeetingControllerProps) {
  const router = useRouter();
  const [meeting, setMeeting] = useState<LiveMeetingInfo | null>(props.meeting);
  const [phase, setPhase] = useState<LivePhase>(() => initialPhase(props.meeting));
  const [startError, setStartError] = useState<StartError>(null);
  const [startErrorText, setStartErrorText] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("ok");
  const [partial, setPartial] = useState("");
  const [micLevel, setMicLevel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoStopped, setAutoStopped] = useState(props.autoStopped ?? false);
  /** When Stopp was pressed (or the stream stopped): the timer freezes there. */
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);
  const [minutesLeft, setMinutesLeft] = useState<number | null>(null);
  const [docPaused, setDocPaused] = useState(props.meeting?.docPaused ?? false);
  const [lastTickOkAt, setLastTickOkAt] = useState<string | null>(props.meeting?.lastTickOkAt ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [health, setHealth] = useState<StreamHealth>({ audioStalled: false, postsFailing: false, authLost: false });
  /** Another tab (or laptop) took over this meeting's session. */
  const [superseded, setSuperseded] = useState(false);

  const capture = useRef<MicCapture | null>(null);
  const stream = useRef<LiveStream | null>(null);
  const userStopped = useRef(false);
  /** Set once the user chose to leave, so the beforeunload prompt doesn't ask a second time. */
  const leaving = useRef(false);
  /** When posted runs were acknowledged; pruned once a notes write is newer. */
  const postedAt = useRef<number[]>([]);

  const mic = () => (capture.current ??= new MicCapture());

  // The server page re-renders (router.refresh) while ending; follow its status.
  useEffect(() => {
    const m = props.meeting;
    if (!m) return;
    setMeeting((cur) => (cur && cur.id === m.id ? { ...cur, status: m.status, durationSeconds: m.durationSeconds } : cur));
    if (m.status !== "ending") setPhase((p) => (p === "ending" ? initialPhase(m) : p));
  }, [props.meeting]);

  // Clock for the timer, "uppdaterat för N min sedan" and the stale check.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // While the final pass runs on the server, re-read the meeting until it is done.
  useEffect(() => {
    if (phase !== "ending" || busy) return;
    const t = setInterval(() => router.refresh(), ENDING_POLL_MS);
    return () => clearInterval(t);
  }, [phase, busy, router]);

  // Leaving while the mic runs loses audio: ask first, and post what we have.
  useEffect(() => {
    if (!RUNNING.includes(phase)) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const exit = () => stream.current?.flushOnExit();
    window.addEventListener("beforeunload", warn);
    window.addEventListener("pagehide", exit);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("pagehide", exit);
    };
  }, [phase]);

  // Stop the mic if the component goes away (client navigation).
  useEffect(
    () => () => {
      stream.current?.flushOnExit();
      capture.current?.stop();
    },
    [],
  );

  /**
   * POST /end, then load the meeting's own page: the server decides what it shows (finalizing
   * while `ending`, then ended). That also leaves `/meetings/ny/…`'s tree, which has no meeting.
   */
  const endOnServer = useCallback(async (id: string, auto: boolean) => {
    leaving.current = true;
    setPhase("ending");
    setStoppedAt((t) => t ?? Date.now());
    try {
      await fetch(`/api/meetings/${id}/end`, { method: "POST" });
    } catch {
      // The cron ends it anyway (abandon after 15 min without a heartbeat).
    }
    window.location.replace(`/meetings/${id}${auto ? "?stoppat=1" : ""}`);
  }, []);

  const onStreamState = useCallback(
    (s: StreamStatus, id: string) => {
      setConnection(s.connection === "ok" && (s.state === "connecting" || s.state === "reconnecting") ? "reconnecting" : s.connection);
      switch (s.state) {
        case "connecting":
        case "live":
        case "reconnecting":
          setPhase("live");
          return;
        case "paused":
          setPhase("paused");
          return;
        case "stopping":
          setPhase("ending");
          setStoppedAt((t) => t ?? Date.now());
          return;
        case "stopped":
          if (s.superseded) {
            // The other tab runs the meeting now: don't end it, just stop listening here.
            capture.current?.stop();
            setSuperseded(true);
            return;
          }
          if (userStopped.current) return; // onStop posts /end itself
          setAutoStopped(Boolean(s.autoStopped));
          setBusy(true);
          void endOnServer(id, Boolean(s.autoStopped));
          return;
        case "error":
          if (s.error === "limit" || s.error === "not_live") {
            // A cap or the meeting ended elsewhere: stop cleanly (posts what we have), then end.
            setAutoStopped(true);
            userStopped.current = true;
            setBusy(true);
            void (async () => {
              await stream.current?.stop({ autoStopped: true });
              capture.current?.stop();
              await endOnServer(id, true);
            })();
            return;
          }
          setPhase("error");
          return;
      }
    },
    [endOnServer],
  );

  const runStream = useCallback(
    async (m: LiveMeetingInfo, cap: MicCapture) => {
      const s = new LiveStream({
        meetingId: m.id,
        audio: cap,
        initialClosingSessionId: m.currentElSessionId,
        wakeLock: "wakeLock" in navigator ? { request: () => navigator.wakeLock.request("screen") } : null,
        visibility: {
          isVisible: () => document.visibilityState === "visible",
          onChange: (cb) => {
            document.addEventListener("visibilitychange", cb);
            return () => document.removeEventListener("visibilitychange", cb);
          },
        },
        isOnline: () => navigator.onLine,
        log: (msg, detail) => console.info(`[live] ${msg}`, detail ?? ""),
      });
      stream.current = s;
      s.on("state", (st) => onStreamState(st, m.id));
      s.on("partial", setPartial);
      s.on("heartbeat", (h: HeartbeatInfo) => {
        setMinutesLeft(h.minutesLeft ?? null);
        if (h.docPaused !== undefined) setDocPaused(h.docPaused);
        if (h.lastTickOkAt !== undefined) {
          setLastTickOkAt(h.lastTickOkAt);
          const ok = h.lastTickOkAt ? Date.parse(h.lastTickOkAt) : 0;
          postedAt.current = postedAt.current.filter((t) => t > ok);
        }
      });
      s.on("posted", () => postedAt.current.push(Date.now()));
      s.on("health", setHealth);
      // The consent check's meter hands over to the stream's level (throttled for React).
      cap.stopCheck();
      let lastLevelAt = 0;
      s.on("level", (level) => {
        const t = Date.now();
        if (t - lastLevelAt < 500) return;
        lastLevelAt = t;
        setMicLevel(level);
      });
      await s.start();
    },
    [onStreamState],
  );

  const micProblem = (e: unknown): StartError => {
    const name = (e as { name?: string } | null)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") return "mic-denied";
    return "mic-missing";
  };

  /** Consent step: Starta mötet. The mic is asked for first, straight from the click. */
  const onStart = () => {
    const cap = mic();
    const opened = cap.open();
    setPhase("starting");
    setStartError(null);
    setStartErrorText(null);
    void (async () => {
      try {
        await opened;
      } catch (e) {
        setStartError(micProblem(e));
        setPhase("consent");
        return;
      }
      let created: { meetingId: string; docUrl: string; title: string };
      try {
        const res = await fetch("/api/meetings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orgId: props.orgId, consent: true }),
        });
        const json = (await res.json().catch(() => null)) as ({ message?: string } & Partial<typeof created>) | null;
        if (!res.ok || !json?.meetingId) {
          cap.stop();
          setStartError(res.status === 429 ? "limit" : "start-failed");
          setStartErrorText(json?.message ?? null);
          setPhase("consent");
          return;
        }
        created = json as typeof created;
      } catch {
        cap.stop();
        setStartError("start-failed");
        setStartErrorText("Vi nådde inte servern. Kontrollera nätet och försök igen.");
        setPhase("consent");
        return;
      }
      const m: LiveMeetingInfo = {
        id: created.meetingId,
        status: "live",
        startedAt: new Date().toISOString(),
        docUrl: created.docUrl,
        title: created.title,
        currentElSessionId: null,
        resumable: true,
        lastTickOkAt: null,
        docPaused: false,
      };
      setMeeting(m);
      // The address becomes the meeting's own, so a reload offers "Fortsätt mötet".
      window.history.replaceState(null, "", `/meetings/${m.id}`);
      setPhase("live");
      await runStream(m, cap);
    })();
  };

  /** "Fortsätt mötet": back to live on the server, then the mic (from the click) and a new session. */
  const onResumeMeeting = () => {
    if (!meeting) return;
    const cap = mic();
    const opened = cap.open();
    setBusy(true);
    setStartError(null);
    setStartErrorText(null);
    void (async () => {
      try {
        await opened;
      } catch (e) {
        setStartError(micProblem(e));
        setBusy(false);
        return;
      }
      try {
        const res = await fetch(`/api/meetings/${meeting.id}/resume`, { method: "POST" });
        if (!res.ok) {
          cap.stop();
          const json = (await res.json().catch(() => null)) as { error?: string } | null;
          setStartError("start-failed");
          setStartErrorText(
            json?.error === "org_busy"
              ? "Ett annat möte pågår i föreningen. Avsluta det först."
              : json?.error === "too_old"
                ? "Mötet avbröts för mer än två timmar sedan och kan inte fortsätta. Starta ett nytt möte."
                : null,
          );
          setBusy(false);
          return;
        }
      } catch {
        cap.stop();
        setStartError("start-failed");
        setStartErrorText("Vi nådde inte servern. Kontrollera nätet och försök igen.");
        setBusy(false);
        return;
      }
      setBusy(false);
      setPhase("live");
      // A resumed abandoned meeting is running again: the timer counts from its start, not its end.
      const resumed: LiveMeetingInfo = { ...meeting, status: "live", durationSeconds: undefined };
      setMeeting(resumed);
      await runStream(resumed, cap);
    })();
  };

  const onStop = () => {
    const s = stream.current;
    if (!meeting) return;
    userStopped.current = true;
    setPhase("ending");
    setBusy(true);
    void (async () => {
      await s?.stop();
      capture.current?.stop();
      await endOnServer(meeting.id, false);
    })();
  };

  const onEndUnfinished = () => {
    if (!meeting) return;
    setBusy(true);
    void endOnServer(meeting.id, false);
  };

  const onLeave = () => {
    leaving.current = true;
    stream.current?.flushOnExit();
    capture.current?.stop();
    window.location.assign(props.orgHref);
  };

  // Stale notes: runs reached us > 3 min ago and no notes write since.
  const oldestUnwritten = postedAt.current[0];
  const staleMs = oldestUnwritten ? now - oldestUnwritten : 0;
  const staleMinutes = phase === "live" && staleMs > STALE_AFTER_MS ? Math.floor(staleMs / 60_000) : null;
  const updatedMinutesAgo = lastTickOkAt ? Math.max(0, Math.floor((now - Date.parse(lastTickOkAt)) / 60_000)) : null;
  const startedAt = meeting?.startedAt;
  const elapsedMs =
    meeting?.durationSeconds !== undefined
      ? meeting.durationSeconds * 1000
      : startedAt
        ? Math.max(0, (stoppedAt ?? now) - Date.parse(startedAt))
        : 0;

  const reLogin = () => window.open(`/login?next=/meetings/${meeting?.id ?? ""}`, "_blank", "noopener");
  // Silent failures the status line doesn't cover: say what happened and what to do.
  const notice: LiveNotice | null = !["live", "paused", "error"].includes(phase)
    ? null
    : health.authLost
      ? {
          tone: "danger",
          title: "Du är utloggad — logga in igen",
          text: "Det som sägs hålls kvar i webbläsaren och skickas när du loggat in. Stäng inte den här fliken.",
          action: { label: "Logga in igen", onClick: reLogin },
        }
      : health.audioStalled
        ? {
            tone: "danger",
            title: "Inget ljud från mikrofonen",
            text: "Datorn kan ha somnat eller mikrofonen kopplats bort. Vi försöker starta den igen. Hjälper det inte: ladda om sidan och tryck Fortsätt mötet.",
          }
        : health.postsFailing
          ? {
              tone: "warning",
              title: "Transkriptionen når inte fram just nu",
              text: "Vi försöker igen automatiskt och inget kastas. Stäng inte den här fliken.",
            }
          : null;

  if (superseded) {
    return (
      <div className="live live--centered">
        <section className="resume" aria-labelledby="superseded-title">
          <span className="magnet magnet--ink resume__magnet" aria-hidden="true" />
          <div className="stack stack--2">
            <h1 id="superseded-title" className="consent__title">
              Mötet körs i en annan flik
            </h1>
            <p className="muted">
              Mötet fortsatte i en annan flik eller på en annan dator, så den här fliken slutade lyssna. Du kan stänga den.
            </p>
          </div>
          <div className="cluster">
            <a className="btn btn--lg" href={props.orgHref}>
              Tillbaka till föreningen
            </a>
          </div>
        </section>
      </div>
    );
  }

  return (
    <LiveMeeting
      phase={phase}
      notice={notice}
      orgName={props.orgName}
      orgHref={props.orgHref}
      title={meeting?.title ?? ""}
      shareTranscript={props.shareTranscript}
      startedAt={startedAt}
      elapsedMs={elapsedMs}
      docUrl={meeting?.docUrl ?? null}
      lastUpdatedAt={lastTickOkAt}
      updatedMinutesAgo={updatedMinutesAgo}
      partialText={partial}
      partialSpeaker={null}
      connection={connection}
      docPaused={docPaused}
      staleMinutes={staleMinutes}
      minutesLeft={minutesLeft}
      // Name round and speaker names arrive with Task 11.
      speakers={[]}
      people={[]}
      nameRound={[]}
      startError={startError}
      startErrorText={startErrorText}
      micLevel={micLevel}
      onMicCheck={() => {
        setStartError(null);
        mic()
          .check(setMicLevel)
          .catch((e) => {
            setMicLevel(null);
            setStartError(micProblem(e));
          });
        setMicLevel(0);
      }}
      busy={busy}
      autoStopped={autoStopped}
      onStart={onStart}
      onPause={() => stream.current?.pause()}
      onResume={() => stream.current?.resume()}
      onStop={onStop}
      onReLogin={reLogin}
      onAssignSpeaker={() => {}}
      onNameRoundDone={() => {}}
      onResumeMeeting={onResumeMeeting}
      // An abandoned meeting is already ended (its notes are final); only a live one can be ended here.
      onEndUnfinished={meeting?.status === "live" ? onEndUnfinished : undefined}
      onRetry={() => void stream.current?.retry()}
      onLeave={onLeave}
    />
  );
}
