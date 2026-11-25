// The browser side of a live meeting: mic audio → ElevenLabs (raw WebSocket, single-use token
// from our server) → committed, diarized speaker runs → our ingest. Also the heartbeat and the
// screen wake lock. No React here; the live page maps `state` onto components/live/*.
//
// Rules (docs/plan.md Global Constraints, Task 7):
// - Only diarized runs go to the server; partials are display-only.
// - Socket drop → new token at once with `closingSessionId` (frees the server's lock),
//   backoff 1 s / 2 s / 5 s then every 5 s. Audio is kept in a ring buffer (≤ 60 s) during
//   the reconnect and sent first on the new session.
// - Runs are posted every 3 s; a failed POST is retried, never dropped (a closed session's
//   runs are still accepted by the server). 429 → back off and keep the batch.
// - 3 failed token requests in a row → state 'error'. A network failure (offline) does not
//   count: we keep trying every 5 s while the laptop is off the net. From 'error' (token) we
//   keep trying every 30 s and keep filling the ring buffer, so it recovers on its own.
// - Fatal ElevenLabs errors (quota, terms; auth twice in a row) stop the meeting (state 'error',
//   error 'limit', refusal 'el_service').
// - Every fetch has a 15 s timeout, so a hung request never freezes the page (or Avsluta).
// - Pause sends no audio and buffers none; it is logged on the server.
// - Heartbeat every 10 s; the server answers {warn, stop}; on stop it ends the meeting itself.
//   It also names the server's current session: if another tab took over, this one stops.
// - A segment committed but never diarized (socket drop, session end, Stopp) is still posted,
//   as one run with speaker "unknown".
// - Watchdogs: no mic audio for 5 s → ask the mic to recover; a socket that stays silent while
//   we send speech is treated as dropped. `health` tells the page when something is stuck.
import { parseEvent, toRuns, UNKNOWN_SPEAKER } from "@/lib/elevenlabs/events";
import type { MergeIn, SegmentIn } from "@/lib/segments/types";
import { pcm16ToBase64, rmsLevel, TARGET_RATE } from "./resample";

export const BACKOFF_MS = [1000, 2000, 5000] as const;
export const BACKOFF_STEADY_MS = 5000;
export const RECONNECT_LIMIT_WAIT_MS = 5000;
/** 429 reconnect_limit is also the answer at 30 mints; after this many waits it counts as a failure. */
export const MAX_RECONNECT_LIMIT_WAITS = 4;
export const MAX_TOKEN_FAILURES = 3;
export const FLUSH_MS = 3000;
export const HEARTBEAT_MS = 10_000;
export const CHUNK_MS = 100;
export const BUFFER_MS = 60_000;
export const STOP_DRAIN_MS = 3000;
/** Per POST; the server allows 120 runs and 20 000 chars per minute. */
export const MAX_BATCH_RUNS = 60;
export const MAX_BATCH_CHARS = 8000;
export const MAX_RUN_CHARS = 2000;
const POST_BACKOFF_MIN_MS = 5000;
const POST_BACKOFF_MAX_MS = 30_000;
/** 401/403 on posts: wait this long before trying again (the user may sign in again). */
const AUTH_BACKOFF_MS = 10_000;
export const TOKEN_TIMEOUT_MS = 15_000;
/** Every other fetch (segments, heartbeat, pause) gives up after this long (C1). */
export const FETCH_TIMEOUT_MS = 15_000;
/** Stopp: keep posting what is left for at most this long; the page then takes over (C6). */
export const STOP_FLUSH_MAX_MS = 60_000;
/** In state 'error' after token failures: try a new session this often (C2). */
export const ERROR_RETRY_MS = 30_000;
/** No session_started within this long after open: send the held audio anyway (C12). */
export const SESSION_START_WAIT_MS = 3000;
/** The mic level counts as "hearing the room" from here (same bar as the consent mic check). */
export const HEARD_LEVEL = 0.08;
/** Level below HEARD_LEVEL this long while live → tell the page (C4). */
export const QUIET_NOTICE_MS = 120_000;
/** Message gaps longer than this are logged, to tune SILENT_SOCKET_MS on 11-28 (C3). */
const LOG_GAP_MS = 10_000;
export const MAX_SPEAKER_CHARS = 100;
/** No audio block from the mic for this long → ask the mic to recover (resume / reopen). */
export const AUDIO_STALL_MS = 5000;
/** …and tell the page after this long. */
export const AUDIO_STALL_NOTICE_MS = 10_000;
/** Posts failing (with runs waiting) this long → tell the page. */
export const POST_FAIL_NOTICE_MS = 60_000;
/**
 * A socket that sent nothing for this long while we sent at least SILENT_SOCKET_LOUD_CHUNKS of
 * speech within the last SILENT_SOCKET_MS is treated as dropped. Provisional (Verify on 11-28):
 * with vad, ElevenLabs sends partials about every second of speech; 60 s and a loud bar of 0.15
 * keep a quiet room or a fan from causing reconnect storms. Message gaps > 10 s are logged.
 */
export const SILENT_SOCKET_MS = 60_000;
export const SILENT_SOCKET_LOUD_CHUNKS = 50;
/** rmsLevel above this counts as speech for the silent-socket watchdog. */
export const LOUD_LEVEL = 0.15;
/** ElevenLabs errors that no reconnect can fix: the service account itself (C5). */
const FATAL_EL_ERROR = /quota|terms|payment|billing|insufficient_funds|subscription/;

/** Refusals from the token route that will not go away by retrying. */
const TERMINAL_REFUSALS = new Set([
  "not_found",
  "not_starter",
  "unauthenticated",
  "no_consent",
  "not_live",
  "meeting_length",
  "org_month",
  "global_day",
  "global_usd",
  "kill_switch",
  "mint_cap",
]);
const LIMIT_REFUSALS = new Set(["meeting_length", "org_month", "global_day", "global_usd", "kill_switch"]);

export type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "paused" | "stopping" | "stopped" | "error";
export type StreamError = "token" | "limit" | "not_live" | "mic-denied" | "mic-missing" | "mic" | "refused";

export interface StreamStatus {
  state: StreamState;
  /** Socket health while running: "offline" when the browser has no network. */
  connection: "ok" | "reconnecting" | "offline";
  error?: StreamError;
  /** The server's refusal code, if the error came from the token route. */
  refusal?: string;
  /** Stopped because the server said stop (4 h, caps, kill switch) or ended the meeting. */
  autoStopped?: boolean;
  /** Why it stopped on its own: a limit reason from the heartbeat or token route (C9). */
  stopReason?: string;
  /** Stopped because another tab (or laptop) took over the meeting's session. */
  superseded?: boolean;
}

/** Things the page should tell the user about, beyond the connection state. */
export interface StreamHealth {
  /** No audio from the mic for AUDIO_STALL_NOTICE_MS (sleep, mic gone). */
  audioStalled: boolean;
  /** Runs have been waiting and every post failed for POST_FAIL_NOTICE_MS. */
  postsFailing: boolean;
  /** The server answered 401/403: signed out. Runs are kept until a post succeeds. */
  authLost: boolean;
  /** Blocks arrive, but the level stayed below HEARD_LEVEL for QUIET_NOTICE_MS while live (C4). */
  quiet: boolean;
}

export interface HeartbeatInfo {
  warn: boolean;
  stop: boolean;
  /** Minutes until a cap stops the meeting, while `warn`. */
  minutesLeft?: number | null;
  /** The cap that warns or stops: meeting_length | org_month | global_day | global_usd | kill_switch. */
  reason?: string | null;
  docPaused?: boolean;
  lastTickOkAt?: string | null;
  /** The session the server considers current (another tab may have taken over). */
  currentElSessionId?: string | null;
  status?: string;
}

/** The subset of the browser WebSocket the stream uses (also implemented by test fakes). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** Mic audio as 100 ms blocks of 16 kHz PCM16. */
export interface AudioSource {
  start(onChunk: (pcm: Int16Array) => void): Promise<void>;
  stop(): void;
  /** No blocks are arriving: try to get them going again (resume the context, reopen the mic). */
  recover?(attempt: number): Promise<void>;
  /** Set by the stream: the source calls it when the mic track ended or was muted (C4). */
  onProblem?: ((why: string) => void) | null;
}

export interface WakeLockLike {
  request(): Promise<{ release(): Promise<void> }>;
}

export interface VisibilityLike {
  isVisible(): boolean;
  /** Subscribe to visibility changes; returns an unsubscribe. */
  onChange(cb: () => void): () => void;
}

export interface LiveStreamOptions {
  meetingId: string;
  audio: AudioSource;
  /** The server's current_el_session_id when the page loaded (resume after reload/crash). */
  initialClosingSessionId?: string | null;
  fetch?: typeof fetch;
  createSocket?: (url: string) => SocketLike;
  wakeLock?: WakeLockLike | null;
  visibility?: VisibilityLike | null;
  isOnline?: () => boolean;
  log?: (message: string, detail?: unknown) => void;
}

type Events = {
  partial: (text: string) => void;
  runs: (runs: SegmentIn[]) => void;
  merged: (merge: MergeIn) => void;
  state: (status: StreamStatus) => void;
  heartbeat: (info: HeartbeatInfo) => void;
  level: (level: number) => void;
  /** Runs the server acknowledged (for the "notes are stale" check). */
  posted: (count: number) => void;
  health: (health: StreamHealth) => void;
  /** Runs and merges still waiting for the server (Stopp shows it). */
  pending: (count: number) => void;
};

const OPEN = 1;
const SILENCE_B64 = pcm16ToBase64(new Int16Array((TARGET_RATE * CHUNK_MS) / 1000));

interface QueuedRun {
  seq: number;
  run: SegmentIn;
}
interface QueuedMerge {
  /** Sent only once every run queued before it is acknowledged (the server checks the labels exist). */
  afterSeq: number;
  merge: MergeIn;
}

export class LiveStream {
  private readonly o: Required<Pick<LiveStreamOptions, "meetingId" | "audio">> & LiveStreamOptions;
  private readonly fetch: typeof fetch;
  private readonly listeners: { [K in keyof Events]: Set<Events[K]> } = {
    partial: new Set(),
    runs: new Set(),
    merged: new Set(),
    state: new Set(),
    heartbeat: new Set(),
    level: new Set(),
    posted: new Set(),
    health: new Set(),
    pending: new Set(),
  };

  private status: StreamStatus = { state: "idle", connection: "ok" };
  private paused = false;
  private socket: SocketLike | null = null;
  private socketSessionId: string | null = null;
  /** Bumped for every socket; events from an older socket are ignored. */
  private generation = 0;
  private lastSessionId: string | null;
  private attempt = 0;
  private tokenFailures = 0;
  private limitWaits = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private ring: string[] = [];
  private readonly ringMax = BUFFER_MS / CHUNK_MS;
  private langBySegment = new Map<number, string>();
  /** Committed segments of the current socket not diarized yet (posted as "unknown" if the socket ends). */
  private undiarized = new Map<number, { text: string; lang?: string; startMs: number; endMs: number }>();
  /** Audio sent on the current socket, ms (session-relative clock for undiarized fallbacks). */
  private socketAudioMs = 0;
  private lastCommitAudioMs = 0;
  private lastMessageAt = 0;
  /** Times of loud chunks sent since the socket's last message, newest last (sliding window). */
  private loudAt: number[] = [];
  /** The current socket's session has started (session_started, a first message, or the wait ran out). */
  private sessionStarted = false;
  private startWaitTimer: ReturnType<typeof setTimeout> | null = null;
  /** auth_error from ElevenLabs on consecutive fresh sessions (2 → fatal). */
  private elAuthErrors = 0;
  private errorRetryAt = 0;
  private lastHeardAt = 0;
  private readonly ignoredTypes = new Set<string>();
  private dropCurrent: ((why: string) => void) | null = null;

  private lastChunkAt = 0;
  private recoverAttempts = 0;
  private recovering = false;
  private postFailingSince: number | null = null;
  private authLost = false;
  /** After a 400 on a batch, send this many runs one by one so only the bad one is dropped. */
  private singlesLeft = 0;
  private health: StreamHealth = { audioStalled: false, postsFailing: false, authLost: false, quiet: false };

  private runSeq = 0;
  private queue: QueuedRun[] = [];
  private merges: QueuedMerge[] = [];
  private posting: Promise<void> | null = null;
  private postBackoffMs = 0;
  private postBackoffUntil = 0;

  private nextFlushAt = 0;
  private nextHeartbeatAt = 0;
  private heartbeating = false;
  private intervals: ReturnType<typeof setInterval>[] = [];
  private wakeLock: { release(): Promise<void> } | null = null;
  private unsubscribeVisibility: (() => void) | null = null;

  constructor(options: LiveStreamOptions) {
    this.o = options;
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.lastSessionId = options.initialClosingSessionId ?? null;
  }

  on<K extends keyof Events>(event: K, cb: Events[K]): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  get state(): StreamStatus {
    return this.status;
  }

  /** Runs and merges not yet acknowledged by the server. */
  get pending(): number {
    return this.queue.length + this.merges.length;
  }

  /** Start the mic, the heartbeat and the first session. Resolves once the mic runs. */
  async start(): Promise<void> {
    if (this.status.state !== "idle" && this.status.state !== "error") return;
    this.setStatus({ state: "connecting", connection: "ok" });
    this.o.audio.onProblem = (why) => this.micProblem(why);
    try {
      await this.o.audio.start((pcm) => this.onChunk(pcm));
    } catch (e) {
      this.setStatus({ state: "error", connection: "ok", error: micError(e) });
      return;
    }
    this.tokenFailures = 0;
    this.limitWaits = 0;
    this.attempt = 0;
    const now = Date.now();
    this.lastChunkAt = now;
    this.lastHeardAt = now;
    this.nextFlushAt = now + FLUSH_MS;
    this.nextHeartbeatAt = now;
    this.intervals.push(setInterval(() => this.tick(), 1000));
    this.acquireWakeLock();
    if (this.o.visibility && !this.unsubscribeVisibility) {
      this.unsubscribeVisibility = this.o.visibility.onChange(() => {
        if (this.o.visibility!.isVisible() && this.active()) this.acquireWakeLock();
        if (!this.o.visibility!.isVisible()) void this.flush();
      });
    }
    void this.heartbeat();
    await this.connect();
  }

  /** "Försök igen" after state 'error' (token failures): try a new session right away. */
  async retry(): Promise<void> {
    if (this.status.state !== "error") return;
    if (this.status.error && this.status.error.startsWith("mic")) {
      this.status = { state: "idle", connection: "ok" };
      return this.start();
    }
    this.tokenFailures = 0;
    this.limitWaits = 0;
    this.attempt = 0;
    this.setStatus({ state: this.paused ? "paused" : "connecting", connection: "ok" });
    if (!this.paused) await this.connect();
  }

  /** Stop sending audio (nothing is buffered either). The session stays open. */
  pause(): void {
    if (!this.active() || this.paused) return;
    this.paused = true;
    this.commit();
    this.setStatus({ ...this.status, state: "paused" });
    void this.logPause(true);
  }

  resume(): void {
    if (!this.paused || !this.active()) return;
    this.paused = false;
    void this.logPause(false);
    if (this.socket && this.socket.readyState === OPEN) {
      this.setStatus({ state: "live", connection: "ok" });
    } else {
      this.setStatus({ state: "reconnecting", connection: this.offline() ? "offline" : "reconnecting" });
      if (!this.reconnectTimer && !this.connecting) {
        this.attempt = 0;
        void this.connect();
      }
    }
  }

  /**
   * Stopp: the mic stops, the last audio is committed, trailing diarized events get up to
   * STOP_DRAIN_MS, then every pending run is posted. The caller then POSTs /end.
   */
  async stop(opts: { autoStopped?: boolean; superseded?: boolean; reason?: string } = {}): Promise<void> {
    if (this.status.state === "stopped" || this.status.state === "stopping") return;
    this.setStatus({ ...this.status, state: "stopping" });
    this.o.audio.stop();
    this.clearReconnect();
    const socket = this.socket;
    // Superseded: another tab is listening to the same room now; don't wait for more of ours.
    if (socket && socket.readyState === OPEN && !opts.superseded) {
      this.commit();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, STOP_DRAIN_MS);
        const prev = socket.onclose;
        socket.onclose = (ev) => {
          clearTimeout(timer);
          prev?.(ev);
          resolve();
        };
      });
    }
    this.closeSocket();
    // Each post is bounded by FETCH_TIMEOUT_MS; the whole drain by STOP_FLUSH_MAX_MS. What is
    // still left is the page's to show ("N rader väntar på nätet") and retry with drain().
    await this.drain(STOP_FLUSH_MAX_MS);
    this.teardown();
    this.setStatus({
      state: "stopped",
      connection: "ok",
      ...(opts.autoStopped ? { autoStopped: true } : {}),
      ...(opts.reason ? { stopReason: opts.reason } : {}),
      ...(opts.superseded ? { superseded: true } : {}),
    });
  }

  /**
   * Post what is waiting until nothing is left or `maxMs` passed (works after stop too).
   * Emits `pending` as the count changes. Resolves with what is still waiting.
   */
  async drain(maxMs: number): Promise<number> {
    const until = Date.now() + maxMs;
    this.emit("pending", this.pending);
    while (this.pending > 0 && Date.now() < until) {
      await this.flush(true);
      this.emit("pending", this.pending);
      if (this.pending > 0) await sleep(1000);
    }
    return this.pending;
  }

  /** Page is going away (pagehide): post what we have with keepalive, best effort. */
  flushOnExit(): void {
    // Committed but not yet diarized segments would be lost with the page: post them as "unknown".
    if (this.socketSessionId) this.queueUndiarized(this.socketSessionId);
    void this.flush(true, true);
  }

  // ------------------------------------------------------------------------------------------

  private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const cb of this.listeners[event]) {
      try {
        (cb as (...a: Parameters<Events[K]>) => void)(...args);
      } catch (e) {
        this.log(`listener ${event} threw`, e);
      }
    }
  }

  private setStatus(next: StreamStatus): void {
    this.status = next;
    this.emit("state", next);
  }

  private log(message: string, detail?: unknown): void {
    this.o.log?.(message, detail);
  }

  private active(): boolean {
    const s = this.status.state;
    return s === "connecting" || s === "live" || s === "reconnecting" || s === "paused" || s === "error";
  }

  private offline(): boolean {
    return this.o.isOnline ? !this.o.isOnline() : false;
  }

  private url(path: string): string {
    return `/api/meetings/${this.o.meetingId}/${path}`;
  }

  private onChunk(pcm: Int16Array): void {
    const level = rmsLevel(pcm);
    this.emit("level", level);
    const now = Date.now();
    this.lastChunkAt = now;
    if (level >= HEARD_LEVEL) this.lastHeardAt = now;
    this.recoverAttempts = 0;
    // Timers are throttled in hidden tabs; the audio thread keeps calling, so check here too.
    this.tick();
    if (this.paused || !this.active()) return;
    // In 'error' only a token failure is worth holding audio for: we keep retrying (C2).
    if (this.status.state === "error" && this.status.error !== "token") return;
    const msg = JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: pcm16ToBase64(pcm),
      commit: false,
      sample_rate: TARGET_RATE,
    });
    if (this.socket && this.socket.readyState === OPEN && this.sessionStarted) {
      this.socket.send(msg);
      this.socketAudioMs += CHUNK_MS;
      if (level > LOUD_LEVEL) this.loudAt.push(now);
    } else {
      this.ring.push(msg);
      if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);
    }
  }

  /** Ask ElevenLabs to commit what it has (pause, stop). */
  private commit(): void {
    if (this.socket && this.socket.readyState === OPEN) {
      this.socket.send(
        JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: SILENCE_B64, commit: true, sample_rate: TARGET_RATE }),
      );
    }
  }

  private tick(): void {
    const now = Date.now();
    if (now >= this.nextFlushAt) {
      this.nextFlushAt = now + FLUSH_MS;
      void this.flush();
    }
    if (now >= this.nextHeartbeatAt && this.status.state !== "stopping" && this.status.state !== "stopped") {
      this.nextHeartbeatAt = now + HEARTBEAT_MS;
      void this.heartbeat();
    }
    this.watchdogs(now);
  }

  private watchdogs(now: number): void {
    const running = this.active() && this.status.state !== "error";
    // C2: after token failures keep trying for a new session every 30 s.
    if (this.status.state === "error" && this.status.error === "token" && !this.connecting && !this.paused && now >= this.errorRetryAt) {
      this.errorRetryAt = now + ERROR_RETRY_MS;
      this.log("token: retrying from the error state");
      void this.connect();
    }
    // Mic: no blocks (laptop slept, Safari interrupted the AudioContext, mic unplugged).
    const silentFor = now - this.lastChunkAt;
    if (running && !this.paused && silentFor > AUDIO_STALL_MS * (this.recoverAttempts + 1) && !this.recovering && this.o.audio.recover) {
      this.recovering = true;
      const attempt = ++this.recoverAttempts;
      this.log(`audio: no blocks for ${silentFor} ms; recover attempt ${attempt}`);
      this.o.audio
        .recover(attempt)
        .catch((e) => this.log("audio: recover failed", e))
        .finally(() => {
          this.recovering = false;
        });
    }
    // Socket: open, we sent speech recently, nothing came back for SILENT_SOCKET_MS.
    while (this.loudAt.length && this.loudAt[0] < now - SILENT_SOCKET_MS) this.loudAt.shift();
    if (
      running &&
      this.socket &&
      this.socket.readyState === OPEN &&
      now - this.lastMessageAt > SILENT_SOCKET_MS &&
      this.loudAt.length >= SILENT_SOCKET_LOUD_CHUNKS
    ) {
      this.log(`socket: silent for ${now - this.lastMessageAt} ms while sending speech; reconnecting`);
      this.dropCurrent?.("silent");
    }
    if (this.pending === 0) this.postFailingSince = null;
    const audioStalled = running && !this.paused && silentFor > AUDIO_STALL_NOTICE_MS;
    this.setHealth({
      audioStalled,
      postsFailing: this.postFailingSince !== null && now - this.postFailingSince > POST_FAIL_NOTICE_MS,
      authLost: this.authLost,
      quiet: running && !this.paused && !audioStalled && now - this.lastHeardAt > QUIET_NOTICE_MS,
    });
  }

  private setHealth(next: StreamHealth): void {
    const h = this.health;
    if (
      h.audioStalled === next.audioStalled &&
      h.postsFailing === next.postsFailing &&
      h.authLost === next.authLost &&
      h.quiet === next.quiet
    ) {
      return;
    }
    this.health = next;
    this.emit("health", next);
  }

  /** The mic track ended or was muted (unplugged, OS mute, another app took it): recover now. */
  private micProblem(why: string): void {
    if (!this.active() || this.paused || this.recovering || !this.o.audio.recover) return;
    this.recovering = true;
    // An ended track never comes back: resuming the context would keep feeding silence, so go
    // straight to reopening the mic (attempt ≥ 2). A muted one may unmute: resume first.
    const attempt = why === "ended" ? Math.max(2, ++this.recoverAttempts) : ++this.recoverAttempts;
    this.log(`audio: mic ${why}; recover attempt ${attempt}`);
    this.o.audio
      .recover(attempt)
      .catch((e) => this.log("audio: recover failed", e))
      .finally(() => {
        this.recovering = false;
      });
  }

  // --- token + socket ------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.connecting || !this.active() || this.paused) return;
    this.connecting = true;
    this.reconnectTimer = null;
    const sentClosing = this.lastSessionId;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), TOKEN_TIMEOUT_MS);
    let res: Response;
    let minted = null as { token: string; wsUrl: string; sessionId: string } | null;
    try {
      res = await this.fetch(this.url("token"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sentClosing ? { closingSessionId: sentClosing } : {}),
        signal: abort.signal,
      });
      if (res.ok) minted = (await res.json().catch(() => null)) as typeof minted;
    } catch (e) {
      // No network (or a hung request): keep trying (does not count toward the 3 failures).
      clearTimeout(timeout);
      this.connecting = false;
      this.log("token: network error", e);
      this.scheduleReconnect("offline");
      return;
    }
    clearTimeout(timeout);
    this.connecting = false;
    if (res.ok) {
      // The server made this session current: remember it even if we no longer want it
      // (paused or stopped meanwhile), so the next mint closes it instead of getting 409.
      if (minted?.sessionId) this.lastSessionId = minted.sessionId;
      if (!this.active() || this.paused) return;
      if (!minted?.token || !minted.wsUrl || !minted.sessionId) {
        this.log("token: unreadable response");
        if (++this.tokenFailures >= MAX_TOKEN_FAILURES) this.fail("token", "bad_response");
        else this.scheduleReconnect("reconnecting");
        return;
      }
      this.tokenFailures = 0;
      this.limitWaits = 0;
      const { token, wsUrl, sessionId } = minted;
      this.openSocket(`${wsUrl}${wsUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`, sessionId);
      return;
    }
    if (!this.active() || this.paused) return;

    const body = (await res.json().catch(() => null)) as { error?: string; openSessionId?: string | null } | null;
    const code = body?.error ?? `http_${res.status}`;
    this.log(`token: refused ${res.status} ${code}`);
    if (code === "session_open" && body?.openSessionId && body.openSessionId !== sentClosing && !this.socket) {
      // The server holds a session we never heard of (its token response was lost): close it next.
      this.lastSessionId = body.openSessionId;
      this.scheduleReconnect("reconnecting");
      return;
    }
    if (code === "reconnect_limit" && this.limitWaits < MAX_RECONNECT_LIMIT_WAITS) {
      this.limitWaits++;
      this.scheduleReconnect("reconnecting", RECONNECT_LIMIT_WAIT_MS);
      return;
    }
    if (TERMINAL_REFUSALS.has(code)) {
      this.fail(LIMIT_REFUSALS.has(code) ? "limit" : code === "not_live" ? "not_live" : "refused", code);
      return;
    }
    if (++this.tokenFailures >= MAX_TOKEN_FAILURES) {
      this.fail("token", code);
      return;
    }
    this.scheduleReconnect("reconnecting");
  }

  private openSocket(url: string, sessionId: string): void {
    const gen = ++this.generation;
    const create = this.o.createSocket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
    let socket: SocketLike;
    try {
      socket = create(url);
    } catch (e) {
      this.log("socket: could not open", e);
      this.scheduleReconnect("reconnecting");
      return;
    }
    this.socket = socket;
    this.socketSessionId = sessionId;
    this.langBySegment = new Map();
    this.undiarized = new Map();
    this.socketAudioMs = 0;
    this.lastCommitAudioMs = 0;
    this.lastMessageAt = Date.now();
    this.loudAt = [];
    this.sessionStarted = false;
    this.clearStartWait();
    let dropped = false;
    const drop = (why: string) => {
      if (dropped || gen !== this.generation) return;
      dropped = true;
      this.clearStartWait();
      this.socket = null;
      this.dropCurrent = null;
      this.queueUndiarized(sessionId);
      if (why === "silent") {
        this.generation++;
        try {
          socket.close(4000, "silent");
        } catch {
          /* already closing */
        }
      }
      this.onDrop(why);
    };
    this.dropCurrent = drop;
    // Audio held during the reconnect goes first, in order, once the session has started (C12).
    const begin = (how: string) => {
      if (gen !== this.generation || this.sessionStarted) return;
      this.clearStartWait();
      this.sessionStarted = true;
      if (how !== "session_started") this.log(`socket: no session_started; sending held audio (${how})`);
      const held = this.ring;
      this.ring = [];
      for (const msg of held) socket.send(msg);
      this.socketAudioMs += held.length * CHUNK_MS;
    };
    socket.onopen = () => {
      if (gen !== this.generation) return;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.startWaitTimer = setTimeout(() => begin("waited"), SESSION_START_WAIT_MS);
      if (this.status.state !== "stopping") {
        this.setStatus({ state: this.paused ? "paused" : "live", connection: "ok" });
      }
    };
    socket.onmessage = (ev) => {
      if (gen !== this.generation) return;
      const now = Date.now();
      if (now - this.lastMessageAt > LOG_GAP_MS) this.log(`socket: message gap ${now - this.lastMessageAt} ms`);
      this.lastMessageAt = now;
      this.loudAt = [];
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      const parsed = parseEvent(raw);
      // An error or session end is no sign the session takes audio: keep holding it for the next one.
      if (parsed.kind !== "error" && parsed.kind !== "session_end") {
        begin(parsed.kind === "started" ? "session_started" : `first message ${parsed.kind}`);
      }
      this.onMessage(parsed, sessionId);
    };
    socket.onerror = (ev) => {
      if (gen !== this.generation) return;
      this.log("socket: error", ev);
    };
    socket.onclose = (ev) => {
      if (gen !== this.generation) return;
      this.log(`socket: closed ${ev.code} ${ev.reason}`);
      drop(`close ${ev.code}`);
    };
  }

  private onDrop(why: string): void {
    if (!this.active()) return;
    this.log(`session ${this.socketSessionId} dropped (${why})`);
    if (this.paused) {
      // Reconnect when the meeting resumes; a closed socket while paused mints nothing.
      this.setStatus({ state: "paused", connection: "reconnecting" });
      return;
    }
    if (this.status.state === "error") return;
    this.scheduleReconnect(this.offline() ? "offline" : "reconnecting");
  }

  private scheduleReconnect(connection: "reconnecting" | "offline", delayMs?: number): void {
    if (!this.active()) return;
    this.clearReconnect();
    const delay = delayMs ?? BACKOFF_MS[this.attempt] ?? BACKOFF_STEADY_MS;
    this.attempt++;
    if (!this.paused) this.setStatus({ state: "reconnecting", connection });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearStartWait(): void {
    if (this.startWaitTimer) clearTimeout(this.startWaitTimer);
    this.startWaitTimer = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private fail(error: StreamError, refusal?: string): void {
    this.clearReconnect();
    // A first automatic retry ERROR_RETRY_MS from now (not on a repeated failure from a retry).
    if (this.status.state !== "error") this.errorRetryAt = Date.now() + ERROR_RETRY_MS;
    this.setStatus({ state: "error", connection: "ok", error, ...(refusal ? { refusal } : {}) });
  }

  private closeSocket(): void {
    this.clearStartWait();
    const s = this.socket;
    if (s && this.socketSessionId) this.queueUndiarized(this.socketSessionId);
    this.generation++;
    this.socket = null;
    this.dropCurrent = null;
    if (s && s.readyState <= OPEN) {
      try {
        s.close(1000, "stop");
      } catch {
        /* already closing */
      }
    }
  }

  private onMessage(ev: ReturnType<typeof parseEvent>, sessionId: string): void {
    switch (ev.kind) {
      case "started":
        return;
      case "partial":
        this.elAuthErrors = 0;
        this.emit("partial", ev.text);
        return;
      case "committed": {
        this.elAuthErrors = 0;
        if (ev.lang) this.langBySegment.set(ev.segmentIndex, ev.lang);
        const prev = this.undiarized.get(ev.segmentIndex);
        const text = ev.text.trim() || prev?.text || "";
        if (text) {
          // Times from word timestamps when we have them, else from the audio we had sent.
          const endMs = ev.endMs ?? prev?.endMs ?? this.socketAudioMs;
          const startMs = ev.startMs ?? prev?.startMs ?? Math.min(this.lastCommitAudioMs, endMs);
          this.undiarized.set(ev.segmentIndex, { text, lang: ev.lang ?? prev?.lang, startMs, endMs: Math.max(startMs, endMs) });
          if (!prev) this.lastCommitAudioMs = this.socketAudioMs;
        }
        return;
      }
      case "diarized": {
        this.undiarized.delete(ev.segmentIndex);
        const lang = ev.lang ?? this.langBySegment.get(ev.segmentIndex);
        this.enqueue(toRuns(ev).map((r) => ({ ...r, elSessionId: sessionId, ...(lang ? { lang } : {}) })));
        return;
      }
      case "merged": {
        const merge = { elSessionId: sessionId, from: ev.from, into: ev.into };
        this.merges.push({ afterSeq: this.runSeq, merge });
        this.emit("merged", merge);
        return;
      }
      case "session_end":
        this.log(`session end: ${ev.reason}`);
        return;
      case "error":
        this.log(`elevenlabs: ${ev.code}${ev.message ? `: ${ev.message}` : ""}`);
        this.onElError(ev.code);
        return;
      case "ignored":
        // Each unknown type once, so 11-28 shows what ElevenLabs really sends without flooding.
        if (!this.ignoredTypes.has(ev.type)) {
          this.ignoredTypes.add(ev.type);
          this.log(`elevenlabs: ignoring message type ${ev.type}`);
        }
        return;
      default:
        return;
    }
  }

  /**
   * Fatal service errors stop the meeting (C5): quota / terms / billing at once; auth_error only
   * on two fresh sessions in a row (a single one may be a token that waited too long, e.g. over a
   * sleep, and a new token fixes it).
   */
  private onElError(code: string): void {
    const fatal = FATAL_EL_ERROR.test(code) || (code === "auth_error" && ++this.elAuthErrors >= 2);
    if (!fatal) return;
    this.log(`elevenlabs: fatal ${code}; stopping`);
    this.fail("limit", "el_service");
  }

  /** Sanitize and queue runs (the ingest rejects a whole batch over one bad field). */
  private enqueue(runs: SegmentIn[]): void {
    const clean = runs
      .map((r) => ({
        ...r,
        speaker: (r.speaker || "unknown").slice(0, MAX_SPEAKER_CHARS),
        text: r.text.slice(0, MAX_RUN_CHARS),
        startMs: Math.max(0, Math.round(r.startMs)),
        endMs: Math.max(0, Math.round(r.startMs), Math.round(r.endMs)),
      }))
      .filter((r) => r.text.trim() !== "");
    if (!clean.length) return;
    for (const run of clean) this.queue.push({ seq: ++this.runSeq, run });
    this.emit("runs", clean);
  }

  /** The socket ended: committed segments that never got diarized go out as one "unknown" run. */
  private queueUndiarized(sessionId: string): void {
    if (!this.undiarized.size) return;
    const left = [...this.undiarized.entries()].sort((a, b) => a[0] - b[0]);
    this.undiarized = new Map();
    this.log(`posting ${left.length} committed but undiarized segment(s) as speaker "unknown"`);
    this.enqueue(
      left.map(([segmentIndex, u]) => ({
        elSessionId: sessionId,
        segmentIndex,
        runIndex: 0,
        speaker: UNKNOWN_SPEAKER,
        text: u.text,
        startMs: u.startMs,
        endMs: u.endMs,
        ...(u.lang ? { lang: u.lang } : {}),
      })),
    );
  }

  // --- ingest ---------------------------------------------------------------------------------

  /** Post one batch (if any is due). `force` ignores the 429 backoff (stop / page exit). */
  private flush(force = false, keepalive = false): Promise<void> {
    if (this.posting) return this.posting;
    if (!this.queue.length && !this.merges.length) return Promise.resolve();
    if (!force && Date.now() < this.postBackoffUntil) return Promise.resolve();
    this.posting = this.postBatch(keepalive).finally(() => {
      this.posting = null;
    });
    return this.posting;
  }

  private async postBatch(keepalive: boolean): Promise<void> {
    const batch: QueuedRun[] = [];
    let chars = 0;
    const maxRuns = this.singlesLeft > 0 ? 1 : MAX_BATCH_RUNS;
    for (const q of this.queue) {
      if (batch.length >= maxRuns || (batch.length > 0 && chars + q.run.text.length > MAX_BATCH_CHARS)) break;
      batch.push(q);
      chars += q.run.text.length;
    }
    const allQueued = batch.length === this.queue.length;
    const lastSeq = batch.length ? batch[batch.length - 1].seq : 0;
    const merges = this.merges.filter((m) => allQueued || m.afterSeq <= lastSeq);
    if (!batch.length && !merges.length) return;

    let res: Response;
    try {
      res = await this.fetch(this.url("segments"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segments: batch.map((b) => b.run), ...(merges.length ? { merges: merges.map((m) => m.merge) } : {}) }),
        keepalive,
        signal: timeoutSignal(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      this.log("segments: network error; retrying", e);
      this.postFailed();
      return;
    }
    const drop = () => {
      this.queue = this.queue.filter((q) => !batch.includes(q));
      this.merges = this.merges.filter((m) => !merges.includes(m));
    };
    if (res.ok) {
      drop();
      if (this.singlesLeft > 0) this.singlesLeft--;
      this.postBackoffMs = 0;
      this.postBackoffUntil = 0;
      this.postFailingSince = null;
      this.authLost = false;
      if (batch.length) this.emit("posted", batch.length);
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const code = body?.error ?? `http_${res.status}`;
    if (code === "not_starter") {
      // Signed in as someone else than the meeting's starter: these runs can never be stored.
      this.log(`segments: 403 not_starter; dropping ${this.queue.length} runs and stopping`);
      this.queue = [];
      this.merges = [];
      this.postFailingSince = null;
      this.notStarter();
      return;
    }
    if (res.status === 401 || res.status === 403) {
      // Signed out (or the session cookie is gone): keep everything and ask the user to log in.
      this.log(`segments: ${res.status} ${code}; keeping ${this.queue.length} runs until signed in again`);
      this.authLost = true;
      this.postBackoffUntil = Date.now() + AUTH_BACKOFF_MS;
      this.postFailed();
      return;
    }
    if (res.status === 429) {
      this.postFailed();
      this.postBackoffMs = Math.min(POST_BACKOFF_MAX_MS, Math.max(POST_BACKOFF_MIN_MS, this.postBackoffMs * 2));
      this.postBackoffUntil = Date.now() + this.postBackoffMs;
      this.log(`segments: ${code}; backing off ${this.postBackoffMs} ms`);
      return;
    }
    if (res.status >= 500) {
      this.log(`segments: ${res.status}; retrying`);
      this.postFailed();
      return;
    }
    if (code === "meeting_not_live") {
      this.log("segments: meeting is no longer live; dropping the queue");
      this.queue = [];
      this.merges = [];
      this.onNotLive();
      return;
    }
    if ((code === "unknown_speaker" || code === "merge_cycle") && merges.length) {
      this.log(`segments: ${code}; dropping the merges, keeping the runs`);
      this.merges = this.merges.filter((m) => !merges.includes(m));
      return;
    }
    if (batch.length > 1) {
      // One bad run fails the whole batch: retry these one by one, so only the bad one is lost.
      this.log(`segments: ${res.status} ${code}; retrying ${batch.length} runs one by one`);
      this.singlesLeft = batch.length;
      return;
    }
    // A single run (or merges only) that fails with another 4xx would fail forever: drop it.
    this.log(`segments: ${res.status} ${code}; dropping ${batch.length} run(s)`);
    if (this.singlesLeft > 0) this.singlesLeft--;
    drop();
  }

  /** This browser is signed in as someone else than the meeting's starter. */
  private notStarter(): void {
    if (this.status.state === "error" && this.status.refusal === "not_starter") return;
    this.o.audio.stop();
    this.closeSocket();
    this.queue = [];
    this.merges = [];
    this.fail("refused", "not_starter");
  }

  private postFailed(): void {
    this.postFailingSince ??= Date.now();
  }

  // --- heartbeat, pause log, wake lock --------------------------------------------------------

  private async heartbeat(): Promise<void> {
    if (this.heartbeating) return;
    this.heartbeating = true;
    // Our session as of now, only while its socket is open. Without an open socket the server's
    // current session may legitimately differ (a claimed session whose mint failed or whose
    // token response was lost); the reconnect sorts that out (I1), so it is never "another tab".
    const expected = this.socket && this.socket.readyState === OPEN && !this.connecting ? this.socketSessionId : null;
    try {
      const res = await this.fetch(this.url("heartbeat"), { method: "POST", signal: timeoutSignal(FETCH_TIMEOUT_MS) });
      if (res.status === 409) {
        this.onNotLive();
        return;
      }
      if (res.status === 401 || res.status === 403) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (body?.error === "not_starter") {
          this.notStarter();
          return;
        }
        this.authLost = true;
        this.watchdogs(Date.now());
        return;
      }
      if (!res.ok) return;
      const info = (await res.json()) as HeartbeatInfo;
      this.authLost = false;
      this.emit("heartbeat", info);
      if (info.stop) {
        void this.stop({ autoStopped: true, ...(info.reason ? { reason: info.reason } : {}) });
        return;
      }
      const current = info.currentElSessionId;
      const stillOpen = this.socket !== null && this.socket.readyState === OPEN && this.socketSessionId === expected;
      if (current && expected && stillOpen && !this.connecting && current !== expected && this.active()) {
        this.log(`session ${expected} is no longer current (${current}): another tab took over`);
        void this.stop({ superseded: true });
      }
    } catch (e) {
      this.log("heartbeat: failed", e);
    } finally {
      this.heartbeating = false;
    }
  }

  /** The meeting was ended elsewhere (server stop, another tab, admin). */
  private onNotLive(): void {
    if (this.status.state === "stopped" || this.status.state === "stopping") return;
    void this.stop({ autoStopped: true });
  }

  private async logPause(paused: boolean): Promise<void> {
    try {
      await this.fetch(this.url("pause"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused }),
        signal: timeoutSignal(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      this.log("pause log failed", e);
    }
  }

  private acquireWakeLock(): void {
    const wl = this.o.wakeLock;
    if (!wl) return;
    wl.request()
      .then((lock) => {
        void this.wakeLock?.release().catch(() => {});
        this.wakeLock = lock;
      })
      .catch((e) => this.log("wake lock refused", e));
  }

  private teardown(): void {
    this.clearStartWait();
    this.o.audio.onProblem = null;
    for (const i of this.intervals) clearInterval(i);
    this.intervals = [];
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.ring = [];
  }
}

function micError(e: unknown): StreamError {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "mic-denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") return "mic-missing";
  return "mic";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** An abort signal that fires after `ms` (a plain timer, so tests' fake clocks drive it too). */
function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(new DOMException("timed out", "TimeoutError")), ms);
  return c.signal;
}
