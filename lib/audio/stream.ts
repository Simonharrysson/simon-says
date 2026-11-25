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
//   count: we keep trying every 5 s while the laptop is off the net.
// - Pause sends no audio and buffers none; it is logged on the server.
// - Heartbeat every 10 s; the server answers {warn, stop}; on stop it ends the meeting itself.
import { parseEvent, toRuns } from "@/lib/elevenlabs/events";
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
}

export interface HeartbeatInfo {
  warn: boolean;
  stop: boolean;
  /** Minutes until a cap stops the meeting, while `warn`. */
  minutesLeft?: number | null;
  docPaused?: boolean;
  lastTickOkAt?: string | null;
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
  async stop(opts: { autoStopped?: boolean } = {}): Promise<void> {
    if (this.status.state === "stopped" || this.status.state === "stopping") return;
    this.setStatus({ ...this.status, state: "stopping" });
    this.o.audio.stop();
    this.clearReconnect();
    const socket = this.socket;
    if (socket && socket.readyState === OPEN) {
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
    for (let i = 0; i < 5 && this.pending > 0; i++) {
      await this.flush(true);
      if (this.pending > 0) await sleep(1000);
    }
    this.teardown();
    this.setStatus({ state: "stopped", connection: "ok", ...(opts.autoStopped ? { autoStopped: true } : {}) });
  }

  /** Page is going away (pagehide): post what we have with keepalive, best effort. */
  flushOnExit(): void {
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
    this.emit("level", rmsLevel(pcm));
    // Timers are throttled in hidden tabs; the audio thread keeps calling, so check here too.
    this.tick();
    if (this.paused || !this.active() || this.status.state === "error") return;
    const msg = JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: pcm16ToBase64(pcm),
      commit: false,
      sample_rate: TARGET_RATE,
    });
    if (this.socket && this.socket.readyState === OPEN) {
      this.socket.send(msg);
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
  }

  // --- token + socket ------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.connecting || !this.active() || this.paused) return;
    this.connecting = true;
    this.reconnectTimer = null;
    let res: Response;
    try {
      res = await this.fetch(this.url("token"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.lastSessionId ? { closingSessionId: this.lastSessionId } : {}),
      });
    } catch (e) {
      // No network: keep trying (does not count toward the 3 failures).
      this.connecting = false;
      this.log("token: network error", e);
      this.scheduleReconnect("offline");
      return;
    }
    this.connecting = false;
    if (!this.active() || this.paused) return;

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? `http_${res.status}`;
      this.log(`token: refused ${res.status} ${code}`);
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
      return;
    }

    const { token, wsUrl, sessionId } = (await res.json()) as { token: string; wsUrl: string; sessionId: string };
    this.tokenFailures = 0;
    this.limitWaits = 0;
    this.lastSessionId = sessionId;
    this.openSocket(`${wsUrl}${wsUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`, sessionId);
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
    let dropped = false;
    const drop = (why: string) => {
      if (dropped || gen !== this.generation) return;
      dropped = true;
      this.socket = null;
      this.onDrop(why);
    };
    socket.onopen = () => {
      if (gen !== this.generation) return;
      this.attempt = 0;
      // Audio held during the reconnect goes first, in order.
      const held = this.ring;
      this.ring = [];
      for (const msg of held) socket.send(msg);
      if (this.status.state !== "stopping") {
        this.setStatus({ state: this.paused ? "paused" : "live", connection: "ok" });
      }
    };
    socket.onmessage = (ev) => {
      if (gen !== this.generation) return;
      this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data), sessionId);
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

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private fail(error: StreamError, refusal?: string): void {
    this.clearReconnect();
    this.setStatus({ state: "error", connection: "ok", error, ...(refusal ? { refusal } : {}) });
  }

  private closeSocket(): void {
    const s = this.socket;
    this.generation++;
    this.socket = null;
    if (s && s.readyState <= OPEN) {
      try {
        s.close(1000, "stop");
      } catch {
        /* already closing */
      }
    }
  }

  private onMessage(raw: string, sessionId: string): void {
    const ev = parseEvent(raw);
    switch (ev.kind) {
      case "partial":
        this.emit("partial", ev.text);
        return;
      case "committed":
        if (ev.lang) this.langBySegment.set(ev.segmentIndex, ev.lang);
        return;
      case "diarized": {
        const lang = ev.lang ?? this.langBySegment.get(ev.segmentIndex);
        const runs: SegmentIn[] = toRuns(ev).map((r) => ({
          ...r,
          text: r.text.slice(0, MAX_RUN_CHARS),
          elSessionId: sessionId,
          ...(lang ? { lang } : {}),
        }));
        if (!runs.length) return;
        for (const run of runs) this.queue.push({ seq: ++this.runSeq, run });
        this.emit("runs", runs);
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
        return;
      default:
        return;
    }
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
    for (const q of this.queue) {
      if (batch.length >= MAX_BATCH_RUNS || (batch.length > 0 && chars + q.run.text.length > MAX_BATCH_CHARS)) break;
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
      });
    } catch (e) {
      this.log("segments: network error; retrying", e);
      return;
    }
    const drop = () => {
      this.queue = this.queue.filter((q) => !batch.includes(q));
      this.merges = this.merges.filter((m) => !merges.includes(m));
    };
    if (res.ok) {
      drop();
      this.postBackoffMs = 0;
      this.postBackoffUntil = 0;
      if (batch.length) this.emit("posted", batch.length);
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const code = body?.error ?? `http_${res.status}`;
    if (res.status === 429) {
      this.postBackoffMs = Math.min(POST_BACKOFF_MAX_MS, Math.max(POST_BACKOFF_MIN_MS, this.postBackoffMs * 2));
      this.postBackoffUntil = Date.now() + this.postBackoffMs;
      this.log(`segments: ${code}; backing off ${this.postBackoffMs} ms`);
      return;
    }
    if (res.status >= 500) {
      this.log(`segments: ${res.status}; retrying`);
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
    // Any other 4xx would fail forever: drop this batch so it can't wedge the meeting.
    this.log(`segments: ${res.status} ${code}; dropping ${batch.length} runs`);
    drop();
  }

  // --- heartbeat, pause log, wake lock --------------------------------------------------------

  private async heartbeat(): Promise<void> {
    if (this.heartbeating) return;
    this.heartbeating = true;
    try {
      const res = await this.fetch(this.url("heartbeat"), { method: "POST" });
      if (res.status === 409) {
        this.onNotLive();
        return;
      }
      if (!res.ok) return;
      const info = (await res.json()) as HeartbeatInfo;
      this.emit("heartbeat", info);
      if (info.stop) void this.stop({ autoStopped: true });
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
