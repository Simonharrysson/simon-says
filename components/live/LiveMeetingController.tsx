"use client";

import { useLocale, useTranslations } from "next-intl";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { MicCapture } from "@/lib/audio/capture";
import { LiveStream, STOP_FLUSH_MAX_MS, type HeartbeatInfo, type StreamHealth, type StreamStatus } from "@/lib/audio/stream";
import { runEndFlow } from "@/lib/live/end-flow";
import { SIGNED_IN_CHANNEL, SIGNED_IN_PATH } from "@/lib/live/signed-in";
import { stopParam } from "@/lib/ui/limit-copy";
import { ContextPicker, type CreateContext, type PrivatChoice } from "@/components/privat/ContextPicker";
import { AgendaStep, missingItemsText, type AgendaChoice, type AgendaFormatOption, type GoalOption } from "./AgendaStep";
import type { StartError } from "./ConsentStep";
import { LiveMeeting, type LiveNotice } from "./LiveMeeting";
import type { NameRoundEntry } from "./NameRound";
import type { ConnectionState, LivePhase, PersonOption, Speaker, SpeakerChoice, SpeakerKey } from "./types";
import type { TaskAnswer, TaskMode, TaskView } from "@/lib/notes/tasks";

/** Notes count as stale when runs posted this long ago have not reached the Doc yet. */
const STALE_AFTER_MS = 3 * 60_000;
/** How often the page re-reads the meeting while the final pass runs elsewhere. */
const ENDING_POLL_MS = 5000;
/** How often the speaker list is re-read: often during the name round, calmly after. */
const SPEAKERS_POLL_NAME_ROUND_MS = 4000;
const SPEAKERS_POLL_MS = 15_000;
/** How often "Uppgifter" is re-read while the meeting runs (a tick is ~45 s). */
const TASKS_POLL_MS = 20_000;
/** Avsluta waits at most this long for the tasks before asking the usual question (never blocks). */
const TASKS_ASK_TIMEOUT_MS = 5000;
/** POST /end must answer within this long, or the page offers a retry (C6). */
const END_TIMEOUT_MS = 15_000;

/** GET/POST/PATCH /api/meetings/[id]/speakers answer this. */
interface SpeakerView {
  currentElSessionId: string | null;
  nameRoundDone: boolean;
  speakers: Speaker[];
  people: PersonOption[];
}

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
  /** Live and another tab is recording it right now: the resume screen offers "Ta över här". */
  connectedElsewhere?: boolean;
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
  /** The meeting was stopped by a limit (4 h, caps), not by a person (`?stoppat=<reason>`). */
  autoStopped?: boolean;
  /** Which limit (from `?stoppat=`), for the copy. */
  stopReason?: string | null;
  /** `?svar=ej-sparade`: the Avsluta answers came after the meeting had already ended. */
  answersLost?: boolean;
  /** Members the Doc could not be shared with at start (from the `started` event); null: unknown. */
  shareFailed?: number | null;
  /** The new Doc missed the förening's meeting folder (the starter's Google account hasn't opened it). */
  missedMeetingFolder?: boolean;
  /** New meeting: the formats the start screen offers (default first). */
  formats?: AgendaFormatOption[];
  /** The Google Picker is configured; off: only a new Doc (as before A11). */
  pickerEnabled?: boolean;
  /** New meeting: "Mål att ta upp" for a new Doc (todo #12). */
  goals?: GoalOption[];
  /** New meeting from "Starta" on a calendar event (todo #14): its id (sent to the server) and title (shown). */
  calendarEvent?: { id: string; title: string } | null;
  /**
   * A Privat recording (0045). New: the contexts to pick from (ContextPicker replaces the agenda
   * step) and how to add one. Either way: where the summary is shown and the back link's words.
   */
  privat?: {
    contexts?: { id: string; name: string }[];
    initialContextId?: string | null;
    createContext?: CreateContext;
    summaryHref: string | null;
    backLabel: string;
  };
}

function initialPhase(m: LiveMeetingInfo | null): LivePhase {
  if (!m) return "consent";
  if (m.status === "ending") return "ending";
  if (m.resumable) return "resume";
  return "ended";
}

/** Stable: AgendaStep reports its choice in an effect that depends on `formats`. */
const NO_FORMATS: AgendaFormatOption[] = [];

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
  const t = useTranslations("live.controller");
  const tPicker = useTranslations("privat.picker");
  const locale = useLocale();
  const [phase, setPhase] = useState<LivePhase>(() => initialPhase(props.meeting));
  const [startError, setStartError] = useState<StartError>(null);
  const [startErrorText, setStartErrorText] = useState<string | null>(null);
  /** The server's error code of a failed start (agenda_* offers "Skapa nytt dokument i stället"). */
  const [startErrorCode, setStartErrorCode] = useState<string | null>(null);
  const [agenda, setAgendaState] = useState<AgendaChoice | null>(null);
  /** The AgendaStep's latest choice, set as it reports it: Start reads this, never a render behind. */
  const agendaRef = useRef<AgendaChoice | null>(null);
  const setAgenda = useCallback((choice: AgendaChoice | null) => {
    agendaRef.current = choice;
    setAgendaState(choice);
  }, []);
  const [privatChoice, setPrivatChoice] = useState<PrivatChoice | null>(null);
  /** Remounts the AgendaStep on "new Doc", confirmed (after an agenda_* error). */
  const [agendaKey, setAgendaKey] = useState(0);
  /** The format override kept across that remount. */
  const [keptFormat, setKeptFormat] = useState<Pick<AgendaChoice, "formatProfileId" | "formatKind"> | null>(null);
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
  const [health, setHealth] = useState<StreamHealth>({ audioStalled: false, postsFailing: false, authLost: false, quiet: false });
  /** The page's first connection is still being made (not a reconnect). */
  const [firstConnect, setFirstConnect] = useState(false);
  /** While reconnecting: when the next attempt is made ("Ansluter igen om N s", R2). */
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  /** The cap behind a warning or an automatic stop. */
  const [limitReason, setLimitReason] = useState<string | null>(props.stopReason ?? null);
  const [shareFailed, setShareFailed] = useState<number | null>(props.shareFailed ?? null);
  /** Required items (stadgar) the agenda Doc lacks, from the start response (C2); dismissable. */
  const [missingItems, setMissingItems] = useState<string | null>(null);
  const [missedFolder, setMissedFolder] = useState(props.missedMeetingFolder === true);
  /** After Avsluta: lines still waiting for the net, and whether POST /end failed. */
  const [pendingRuns, setPendingRuns] = useState(0);
  const [endFailed, setEndFailed] = useState(false);
  /** After Avsluta while signed out: lines that need a new sign-in to be saved (R3). */
  const [signedOutUnsent, setSignedOutUnsent] = useState<number | null>(null);
  /** Another tab (or laptop) took over this meeting's session. */
  const [superseded, setSuperseded] = useState(false);
  /** The stream's last refusal code (e.g. "not_member": signed in with an account outside the förening). */
  const [refusal, setRefusal] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [nameRoundBusy, setNameRoundBusy] = useState(false);
  /** The name round is on (a new meeting, until "Klar", "Hoppa över" or the server ran it). */
  const nameRoundOpen = useRef(false);

  const capture = useRef<MicCapture | null>(null);
  const stream = useRef<LiveStream | null>(null);
  const userStopped = useRef(false);
  /** Set once the user chose to leave, so the beforeunload prompt doesn't ask a second time. */
  const leaving = useRef(false);
  /** When posted runs were acknowledged; pruned once a notes write is newer. */
  const postedAt = useRef<number[]>([]);

  const mic = () => (capture.current ??= new MicCapture());
  /** A Privat recording started on this page: its summary page once it ends. */
  const privatMeetingId = useRef<string | null>(null);

  // The server page re-renders (router.refresh) while ending; follow its status.
  useEffect(() => {
    const m = props.meeting;
    if (!m) return;
    setMeeting((cur) => (cur && cur.id === m.id ? { ...cur, status: m.status, durationSeconds: m.durationSeconds } : cur));
    if (m.status !== "ending") setPhase((p) => (p === "ending" ? initialPhase(m) : p));
  }, [props.meeting]);

  // Signed in again in the other tab (/inloggad): send what waits now (U8).
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(SIGNED_IN_CHANNEL);
    ch.onmessage = () => stream.current?.signedInAgain();
    return () => ch.close();
  }, []);

  // Clock for the timer, "uppdaterat för N min sedan" and the stale check.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // A stopped page says so in the tab title too: the laptop is often in another tab (C2).
  useEffect(() => {
    if (phase !== "error") return;
    const stopped = t("tabStopped");
    const before = document.title;
    document.title = stopped;
    return () => {
      document.title = before === stopped ? t("tabMeeting") : before;
    };
  }, [phase, t]);

  // While the final pass runs on the server, re-read the meeting until it is done.
  useEffect(() => {
    // Not while /end failed or waits for a sign-in: the meeting is still live on the server, and a
    // refresh would turn this page into "Fortsätt mötet" under the user's feet.
    if (phase !== "ending" || busy || endFailed || signedOutUnsent != null) return;
    const t = setInterval(() => router.refresh(), ENDING_POLL_MS);
    return () => clearInterval(t);
  }, [phase, busy, endFailed, signedOutUnsent, router]);

  // Leaving while the mic runs (or lines still wait for the net after Avsluta) loses them: ask
  // first, and post what we have.
  const holding = RUNNING.includes(phase) || pendingRuns > 0;
  useEffect(() => {
    if (!holding) return;
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
  }, [holding]);

  // Stop the mic if the component goes away (client navigation).
  useEffect(
    () => () => {
      stream.current?.flushOnExit();
      capture.current?.stop();
    },
    [],
  );

  /**
   * Post every waiting line (C6: "N rader väntar på nätet" meanwhile), then POST /end, then
   * load the meeting's own page: the server decides what it shows (finalizing while `ending`,
   * then ended). That also leaves `/meetings/ny/…`'s tree, which has no meeting. A failed /end
   * keeps the page here with a retry instead of navigating away from unsent work.
   */
  const endOnServer = useCallback(
    async (id: string, auto: boolean, reason?: string | null, endWithoutUnsent = false, answers: TaskAnswer[] = []) => {
      setPhase("ending");
      setStoppedAt((t) => t ?? Date.now());
      setEndFailed(false);
      setSignedOutUnsent(null);
      /** The meeting had already ended elsewhere and its final pass had started: the answers were not saved. */
      let answersLost = false;
      const outcome = await runEndFlow({
        stream: stream.current,
        drainRoundMs: STOP_FLUSH_MAX_MS,
        onPending: setPendingRuns,
        endWithoutUnsent,
        // /end claims `ending` and answers at once; the final pass runs on the server (R1).
        postEnd: async () => {
          const res = await fetch(`/api/meetings/${id}/end`, {
            method: "POST",
            signal: AbortSignal.timeout(END_TIMEOUT_MS),
            // The Avsluta dialog's Vem / När / Klart när: the final pass writes them to the Doc.
            ...(answers.length ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ answers }) } : {}),
          });
          if (res.ok && answers.length) {
            const body = (await res.json().catch(() => null)) as { answers?: string } | null;
            answersLost = body?.answers === "not_saved";
          }
          return res.status;
        },
      });
      if (outcome.kind === "end_failed") {
        setEndFailed(true);
        setBusy(false);
        return;
      }
      if (outcome.kind === "signed_out") {
        setSignedOutUnsent(outcome.unsent);
        setBusy(false);
        return;
      }
      leaving.current = true;
      const query = [auto ? `stoppat=${stopParam(reason)}` : null, answersLost ? "svar=ej-sparade" : null].filter(Boolean).join("&");
      window.location.replace(`/meetings/${id}${query ? `?${query}` : ""}`);
    },
    [],
  );

  const onStreamState = useCallback(
    (s: StreamStatus, id: string) => {
      setRefusal(s.state === "error" ? (s.refusal ?? null) : null);
      setStreamError(s.state === "error" ? (s.error ?? null) : null);
      setFirstConnect(s.state === "connecting");
      setRetryAt(s.state === "reconnecting" ? (s.retryAt ?? null) : null);
      setConnection(s.connection === "ok" && (s.state === "connecting" || s.state === "reconnecting") ? "reconnecting" : s.connection);
      switch (s.state) {
        case "connecting":
        case "live":
        case "reconnecting":
          setPhase(nameRoundOpen.current ? "name-round" : "live");
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
          if (s.stopReason) setLimitReason(s.stopReason);
          setBusy(true);
          void endOnServer(id, Boolean(s.autoStopped), s.stopReason);
          return;
        case "error":
          if (s.error === "limit" || s.error === "not_live") {
            // A cap or the meeting ended elsewhere: stop cleanly (posts what we have), then end.
            setAutoStopped(true);
            if (s.refusal) setLimitReason(s.refusal);
            userStopped.current = true;
            setBusy(true);
            void (async () => {
              await stream.current?.stop({ autoStopped: true, ...(s.refusal ? { reason: s.refusal } : {}) });
              capture.current?.stop();
              await endOnServer(id, true, s.refusal);
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
        if (h.reason !== undefined) setLimitReason(h.reason ?? null);
        if (h.docPaused !== undefined) setDocPaused(h.docPaused);
        if (h.lastTickOkAt !== undefined) {
          setLastTickOkAt(h.lastTickOkAt);
          const ok = h.lastTickOkAt ? Date.parse(h.lastTickOkAt) : 0;
          postedAt.current = postedAt.current.filter((t) => t > ok);
        }
      });
      s.on("posted", () => postedAt.current.push(Date.now()));
      s.on("health", setHealth);
      // Stopp's own drain reports what still waits for the net (C6).
      s.on("pending", setPendingRuns);
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
    setStartErrorCode(null);
    const choice = agendaRef.current;
    const privatStart = props.privat ? privatChoice : null;
    void (async () => {
      try {
        await opened;
      } catch (e) {
        setMicLevel(null);
        setStartError(micProblem(e));
        setPhase("consent");
        return;
      }
      let created: {
        meetingId: string;
        docUrl: string;
        title: string;
        shareFailed?: number;
        missedMeetingFolder?: boolean;
        warnings?: string[];
      };
      try {
        const res = await fetch("/api/meetings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(privatStart ? { orgId: props.orgId, consent: true, contextId: privatStart.contextId, withDoc: privatStart.withDoc } : {
            orgId: props.orgId,
            consent: true,
            agendaDocId: choice?.agendaDocId ?? null,
            formatProfileId: choice?.formatProfileId ?? null,
            formatKind: choice?.formatKind ?? null,
            transcriptInDoc: choice?.agendaDocId ? choice.transcriptInDoc : null,
            // Only for a new Doc in a format; the server re-reads the titles.
            ...(!choice?.agendaDocId && choice?.goalIds?.length ? { goalIds: choice.goalIds } : {}),
            // The server reads the event again with the starter's own grant.
            ...(props.calendarEvent ? { calendarEventId: props.calendarEvent.id } : {}),
          }),
        });
        const json = (await res.json().catch(() => null)) as ({ message?: string; error?: string } & Partial<typeof created>) | null;
        if (!res.ok || !json?.meetingId) {
          cap.stop();
          // The mic is let go: no frozen meter; Testa mikrofonen comes back.
          setMicLevel(null);
          setStartError(res.status === 429 ? "limit" : "start-failed");
          setStartErrorText(json?.message ?? null);
          setStartErrorCode(typeof json?.error === "string" ? json.error : null);
          setPhase("consent");
          return;
        }
        created = json as typeof created;
      } catch {
        cap.stop();
        setMicLevel(null);
        setStartError("start-failed");
        setStartErrorText(t("offline"));
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
      if (privatStart) privatMeetingId.current = m.id;
      setShareFailed(typeof created.shareFailed === "number" ? created.shareFailed : null);
      setMissingItems(missingItemsText(Array.isArray(created.warnings) ? created.warnings : null, locale));
      setMissedFolder(created.missedMeetingFolder === true);
      // The address becomes the meeting's own, so a reload offers "Fortsätt mötet".
      window.history.replaceState(null, "", `/meetings/${m.id}`);
      nameRoundOpen.current = true;
      setPhase("name-round");
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
              ? t("orgBusy")
              : json?.error === "too_old"
                ? t("tooOld")
                : null,
          );
          setBusy(false);
          return;
        }
      } catch {
        cap.stop();
        setStartError("start-failed");
        setStartErrorText(t("offline"));
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

  const closeNameRound = useCallback(() => {
    nameRoundOpen.current = false;
    setPhase((p) => (p === "name-round" ? "live" : p));
  }, []);

  const applyView = useCallback(
    (v: SpeakerView) => {
      setSpeakers(v.speakers);
      setPeople(v.people);
      setCurrentSession(v.currentElSessionId);
      // The server ran the round on its own (about two minutes in): the list takes over, and
      // voices without a name show there as "Vem är detta?" (C7). Later sessions (the hourly
      // rollover, reconnects) never reopen the round.
      if (nameRoundOpen.current && v.nameRoundDone) closeNameRound();
    },
    [closeNameRound],
  );

  const speakersUrl = meeting ? `/api/meetings/${meeting.id}/speakers` : null;
  const loadSpeakers = useCallback(async () => {
    if (!speakersUrl) return;
    try {
      const res = await fetch(speakersUrl, { cache: "no-store" });
      if (res.ok) applyView((await res.json()) as SpeakerView);
    } catch {
      // Next poll.
    }
  }, [speakersUrl, applyView]);

  // The speaker list follows the server while the meeting runs.
  const polling = phase === "name-round" || phase === "live" || phase === "paused";
  const pollMs = phase === "name-round" ? SPEAKERS_POLL_NAME_ROUND_MS : SPEAKERS_POLL_MS;
  useEffect(() => {
    if (!polling || !speakersUrl) return;
    void loadSpeakers();
    const t = setInterval(() => void loadSpeakers(), pollMs);
    return () => clearInterval(t);
  }, [polling, pollMs, speakersUrl, loadSpeakers]);

  // "Uppgifter" (concrete tasks) follows the server like the speaker list, more calmly.
  const [tasks, setTasks] = useState<TaskView[] | undefined>(undefined);
  const tasksUrl = meeting ? `/api/meetings/${meeting.id}/tasks` : null;
  const fetchTasks = useCallback(
    async (timeoutMs?: number): Promise<{ mode: TaskMode; tasks: TaskView[] } | null> => {
      if (!tasksUrl) return null;
      try {
        const res = await fetch(tasksUrl, { cache: "no-store", ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
        if (!res.ok) return null;
        const v = (await res.json()) as { mode: TaskMode; tasks: TaskView[] };
        setTasks(v.tasks);
        return v;
      } catch {
        return null; // next poll
      }
    },
    [tasksUrl],
  );
  const tasksPolling = phase === "live" || phase === "paused";
  useEffect(() => {
    if (!tasksPolling || !tasksUrl) return;
    void fetchTasks();
    const t = setInterval(() => void fetchTasks(), TASKS_POLL_MS);
    return () => clearInterval(t);
  }, [tasksPolling, tasksUrl, fetchTasks]);
  /** Avsluta: the incomplete tasks to ask about, fresh; none when the förening doesn't require them or the read fails. */
  const askTasks = useCallback(async (): Promise<TaskView[]> => {
    const v = await fetchTasks(TASKS_ASK_TIMEOUT_MS);
    return v?.mode === "require" ? v.tasks.filter((x) => x.missing.length > 0) : [];
  }, [fetchTasks]);

  /** "Klar": read the names now (the server only fills voices nobody has named). */
  const onNameRoundDone = () => {
    if (!speakersUrl) return closeNameRound();
    setNameRoundBusy(true);
    void (async () => {
      try {
        const res = await fetch(speakersUrl, { method: "POST" });
        if (res.ok) applyView((await res.json()) as SpeakerView);
      } catch {
        // The server's own round still runs; names can be set in the list.
      }
      setNameRoundBusy(false);
      closeNameRound();
    })();
  };

  /** Name a speaker: shown at once, saved, then the server's list. */
  const onAssignSpeaker = (key: SpeakerKey, choice: SpeakerChoice) => {
    if (!speakersUrl) return;
    setSpeakers((all) =>
      all.map((s) =>
        s.elSessionId === key.elSessionId && s.speakerLabel === key.speakerLabel
          ? { ...s, displayName: choice.displayName, needsConfirm: false }
          : s,
      ),
    );
    void (async () => {
      try {
        const res = await fetch(speakersUrl, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ elSessionId: key.elSessionId, speakerLabel: key.speakerLabel, ...choice }),
        });
        if (res.ok) {
          applyView((await res.json()) as SpeakerView);
          return;
        }
      } catch {
        // fall through: show the server's list again
      }
      await loadSpeakers();
    })();
  };

  const nameRound: NameRoundEntry[] = speakers
    .filter((s) => !currentSession || s.elSessionId === currentSession)
    .map((s) => ({ key: `${s.elSessionId}::${s.speakerLabel}`, label: s.label, name: s.displayName, needsConfirm: s.needsConfirm }));

  /** The Avsluta dialog's answers, kept for "Försök igen" after a failed POST /end. */
  const endAnswers = useRef<TaskAnswer[]>([]);
  const onStop = (answers?: TaskAnswer[]) => {
    const s = stream.current;
    if (!meeting) return;
    endAnswers.current = answers ?? [];
    userStopped.current = true;
    setPhase("ending");
    setBusy(true);
    void (async () => {
      await s?.stop();
      capture.current?.stop();
      await endOnServer(meeting.id, false, undefined, false, answers);
    })();
  };

  /** "Försök igen" after a failed POST /end (or after signing in again). */
  const onRetryEnd = () => {
    if (!meeting) return;
    setBusy(true);
    void endOnServer(meeting.id, autoStopped, limitReason, false, endAnswers.current);
  };

  /** Signed out: end with what the server has; the unsent lines are given up (R3). */
  const onEndWithoutUnsent = () => {
    if (!meeting) return;
    setBusy(true);
    void endOnServer(meeting.id, autoStopped, limitReason, true, endAnswers.current);
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
  const staleMinutes = (phase === "live" || phase === "name-round") && staleMs > STALE_AFTER_MS ? Math.floor(staleMs / 60_000) : null;
  const retryInSeconds = retryAt && retryAt > now ? Math.ceil((retryAt - now) / 1000) : null;
  const updatedMinutesAgo = lastTickOkAt ? Math.max(0, Math.floor((now - Date.parse(lastTickOkAt)) / 60_000)) : null;
  const startedAt = meeting?.startedAt;
  const elapsedMs =
    meeting?.durationSeconds !== undefined
      ? meeting.durationSeconds * 1000
      : startedAt
        ? Math.max(0, (stoppedAt ?? now) - Date.parse(startedAt))
        : 0;

  // The sign-in tab lands on /inloggad ("close this tab"), never on this meeting: a second
  // meeting tab would offer "Fortsätt mötet" and take the recording over from this one (U8).
  const reLogin = () => window.open(`/login?next=${SIGNED_IN_PATH}`, "_blank", "noopener");
  // Silent failures the status line doesn't cover: say what happened and what to do.
  const notice: LiveNotice | null = !["live", "paused", "error", "name-round"].includes(phase)
    ? null
    : refusal === "meeting_gone"
      ? {
          tone: "danger",
          title: t("goneTitle"),
          text: t("goneText"),
        }
    : refusal === "not_member"
      ? {
          tone: "danger",
          title: t("wrongAccountTitle"),
          text: t("wrongAccountText"),
          action: { label: t("reLogin"), onClick: reLogin },
        }
      : health.authLost
      ? {
          tone: "danger",
          title: t("signedOutTitle"),
          text: t("signedOutText"),
          action: { label: t("reLogin"), onClick: reLogin },
        }
      : health.audioStalled
        ? {
            tone: "danger",
            title: t("noAudioTitle"),
            text: t("noAudioText"),
          }
        : health.postsFailing
          ? {
              tone: "warning",
              title: t("postsTitle"),
              text: t("postsText"),
            }
          : health.quiet && phase !== "paused"
            ? {
                tone: "warning",
                title: t("quietTitle"),
                text: t("quietText"),
              }
            : shareFailed && shareFailed > 0
              ? {
                  tone: "warning",
                  title: t("shareTitle", { count: shareFailed }),
                  text: t("shareText"),
                }
              : missedFolder
                ? {
                    tone: "warning",
                    title: t("folderTitle"),
                    text: t("folderText", { org: props.orgName }),
                    action: { label: t("ok"), onClick: () => setMissedFolder(false) },
                  }
                : missingItems
                ? {
                    tone: "warning",
                    title: t("missingTitle"),
                    text: missingItems,
                    action: { label: t("ok"), onClick: () => setMissingItems(null) },
                  }
                : null;

  if (superseded) {
    return (
      <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-6 px-gutter pt-[clamp(1.5rem,8vh,5rem)] pb-12">
        <section className="flex flex-col gap-6 rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel" aria-labelledby="superseded-title">
          <div className="flex flex-col gap-2">
            <h1 id="superseded-title" className="text-2xl">
              {t("supersededTitle")}
            </h1>
            <p className="text-ink-2">
              {t("supersededText")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <a className={buttonVariants({ size: "lg" })} href={props.orgHref}>
              {t("backToOrg")}
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
      firstConnect={firstConnect}
      docPaused={docPaused}
      staleMinutes={staleMinutes}
      minutesLeft={minutesLeft}
      limitReason={limitReason}
      streamError={streamError}
      refusal={refusal}
      shareFailed={shareFailed}
      pendingRuns={pendingRuns}
      endFailed={endFailed}
      onRetryEnd={onRetryEnd}
      signedOutUnsent={signedOutUnsent}
      onEndWithoutUnsent={onEndWithoutUnsent}
      retryInSeconds={retryInSeconds}
      speakers={speakers}
      people={people}
      nameRound={nameRound}
      nameRoundBusy={nameRoundBusy}
      startError={startError}
      startErrorText={startErrorText}
      privat={
        props.privat
          ? {
              summaryHref: props.privat.summaryHref ?? (privatMeetingId.current ? `/privat/mote/${privatMeetingId.current}` : null),
              backLabel: props.privat.backLabel,
            }
          : null
      }
      agenda={
        props.meeting === null && props.privat ? (
          <ContextPicker
            contexts={props.privat.contexts ?? []}
            initialId={props.privat.initialContextId ?? null}
            create={props.privat.createContext ?? (async () => ({ ok: false, message: tPicker("failed") }))}
            onChange={setPrivatChoice}
            disabled={phase === "starting"}
          />
        ) : props.meeting === null ? (
          <AgendaStep
            key={agendaKey}
            orgId={props.orgId}
            formats={props.formats ?? NO_FORMATS}
            pickerEnabled={props.pickerEnabled ?? false}
            shareTranscript={props.shareTranscript}
            startWithNewDoc={agendaKey > 0}
            initialFormat={keptFormat}
            disabled={phase === "starting"}
            onChange={setAgenda}
            goals={props.goals}
            eventTitle={props.calendarEvent?.title ?? null}
          />
        ) : undefined
      }
      agendaConfirmed={props.meeting === null ? (props.privat ? privatChoice !== null : agenda?.confirmed === true) : true}
      agendaDoc={agenda?.agendaDocId ? { transcriptInDoc: agenda.transcriptInDoc } : null}
      onNewDocInstead={
        startError === "start-failed" && startErrorCode?.startsWith("agenda_")
          ? () => {
              setStartError(null);
              setStartErrorText(null);
              setStartErrorCode(null);
              setKeptFormat(agenda ? { formatProfileId: agenda.formatProfileId, formatKind: agenda.formatKind } : null);
              setAgenda(null);
              setAgendaKey((k) => k + 1);
            }
          : undefined
      }
      micLevel={micLevel}
      eventTitle={props.calendarEvent?.title ?? null}
      onMicCheck={() => {
        setStartError(null);
        const cap = mic();
        cap
          .check(setMicLevel)
          // Unticked while the mic was still opening: let go of it once it is open.
          .then(() => capture.current !== cap && cap.stop())
          .catch((e) => {
            if (capture.current !== cap) return;
            setMicLevel(null);
            setStartError(micProblem(e));
          });
        setMicLevel(0);
      }}
      onMicCheckStop={() => {
        capture.current?.stop();
        capture.current = null;
        setMicLevel(null);
      }}
      busy={busy}
      autoStopped={autoStopped}
      onStart={onStart}
      onPause={() => stream.current?.pause()}
      onResume={() => stream.current?.resume()}
      onStop={onStop}
      answersLost={props.answersLost}
      tasks={tasks}
      askTasks={askTasks}
      onReLogin={reLogin}
      onAssignSpeaker={onAssignSpeaker}
      onNameRoundDone={onNameRoundDone}
      onNameRoundSkip={closeNameRound}
      onResumeMeeting={onResumeMeeting}
      connectedElsewhere={meeting?.connectedElsewhere ?? false}
      resumeLive={meeting?.status === "live"}
      // An abandoned meeting is already ended (its notes are final); only a live one can be ended here.
      onEndUnfinished={meeting?.status === "live" ? onEndUnfinished : undefined}
      onRetry={() => void stream.current?.retry()}
      onLeave={onLeave}
    />
  );
}
