import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64ToPcm16 } from "./resample";
import {
  AUDIO_STALL_MS,
  AUDIO_STALL_NOTICE_MS,
  ERROR_RETRY_MS,
  FETCH_TIMEOUT_MS,
  FLUSH_MS,
  QUIET_NOTICE_MS,
  SESSION_START_WAIT_MS,
  STOP_FLUSH_MAX_MS,
  HEARTBEAT_MS,
  LiveStream,
  STOP_DRAIN_MS,
  type AudioSource,
  type SocketLike,
  type StreamStatus,
} from "./stream";

// --- fakes ------------------------------------------------------------------------------------

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedByClient = false;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closedByClient = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "client" });
  }
  /** Open and start the session (session_started), as ElevenLabs does. */
  open() {
    this.openOnly();
    this.emit({ message_type: "session_started", session_id: "el" });
  }
  /** Open without session_started (C12). */
  openOnly() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
  /** The first sample of every audio chunk sent (chunks are tagged by their first sample). */
  get audioTags() {
    return this.sent.filter((m) => m.message_type === "input_audio_chunk" && !m.commit).map((m) => base64ToPcm16(m.audio_base_64 as string)[0]);
  }
}

class FakeAudio implements AudioSource {
  onChunk: ((pcm: Int16Array) => void) | null = null;
  onProblem: ((why: string) => void) | null = null;
  stopped = false;
  error: Error | null = null;
  async start(onChunk: (pcm: Int16Array) => void) {
    if (this.error) throw this.error;
    this.onChunk = onChunk;
  }
  recovers: number[] = [];
  stop() {
    this.stopped = true;
  }
  async recover(attempt: number) {
    this.recovers.push(attempt);
  }
  /** Push one 100 ms chunk whose first sample is `tag` (`loud`: speech-level audio). */
  push(tag: number, loud = false) {
    const pcm = new Int16Array(1600).fill(loud ? 8000 : 0);
    pcm[0] = tag;
    this.onChunk?.(pcm);
  }
}

type Reply = { status: number; body?: unknown } | "network" | "hang";
const json = (status: number, body?: unknown) => ({ status, body });

function makeFetch() {
  const replies: Record<string, Reply[]> = { token: [], segments: [], heartbeat: [], pause: [] };
  const calls: { path: string; body: any }[] = [];
  let sessions = 0;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("/").at(-1)!;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, body });
    let reply = replies[path]?.shift();
    if (!reply) {
      if (path === "token") reply = json(200, { token: `tok${++sessions}`, wsUrl: "wss://fake/realtime?model_id=scribe_v3_live", sessionId: `s${sessions}` });
      else if (path === "heartbeat") reply = json(200, { warn: false, stop: false });
      else reply = json(200, { stored: 1, received: 1 });
    }
    if (reply === "network") throw new TypeError("Failed to fetch");
    if (reply === "hang") {
      // Never answers; only the request's abort signal ends it (C1).
      return new Promise<Response>((_res, rej) => {
        const sig = init?.signal;
        if (!sig) return;
        sig.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
    }
    const r = reply;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetchFn, replies, calls, of: (path: string) => calls.filter((c) => c.path === path) };
}

function setup(opts: { initialClosingSessionId?: string | null; log?: (m: string) => void; shortSessionMs?: number } = {}) {
  const f = makeFetch();
  const audio = new FakeAudio();
  const sockets: FakeSocket[] = [];
  const states: StreamStatus[] = [];
  const stream = new LiveStream({
    meetingId: "m1",
    audio,
    fetch: f.fetchFn as unknown as typeof fetch,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    initialClosingSessionId: opts.initialClosingSessionId,
    log: opts.log,
    // Most tests drop sockets at once; the R2 short-session wait has its own tests.
    shortSessionMs: opts.shortSessionMs ?? 0,
  });
  stream.on("state", (s) => states.push(s));
  return { stream, audio, sockets, states, ...f };
}

const diarized = (segment_index: number, words: [string, string][]) => ({
  message_type: "diarized_transcript",
  segment_index,
  words: words.map(([text, speaker_id], i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4, type: "word", speaker_id })),
});

/** Let pending promises (fetch replies) settle. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// --- tests ------------------------------------------------------------------------------------

describe("LiveStream", () => {
  it("mints a token, connects with it as `token` query param and streams 16 kHz base64 PCM", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    expect(t.of("token")[0].body).toEqual({});
    expect(t.sockets).toHaveLength(1);
    expect(t.sockets[0].url).toBe("wss://fake/realtime?model_id=scribe_v3_live&token=tok1");
    t.sockets[0].open();
    expect(t.stream.state.state).toBe("live");
    t.audio.push(7);
    const msg = t.sockets[0].sent[0];
    expect(msg).toMatchObject({ message_type: "input_audio_chunk", commit: false, sample_rate: 16000 });
    expect(base64ToPcm16(msg.audio_base_64 as string)).toHaveLength(1600);
    expect(t.sockets[0].audioTags).toEqual([7]);
  });

  it("resumes with the server's current session as closingSessionId", async () => {
    const t = setup({ initialClosingSessionId: "old-session" });
    await t.stream.start();
    expect(t.of("token")[0].body).toEqual({ closingSessionId: "old-session" });
  });

  it("on socket close: new token with closingSessionId, buffered audio first on the new socket, old session's runs still posted", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.audio.push(1);
    t.sockets[0].emit(diarized(0, [["Hej", "speaker_0"], ["där", "speaker_0"]]));
    t.sockets[0].drop();
    expect(t.stream.state).toMatchObject({ state: "reconnecting", connection: "reconnecting" });

    // Audio during the gap is held …
    t.audio.push(2);
    t.audio.push(3);
    await vi.advanceTimersByTimeAsync(1000); // first backoff step
    await settle();
    expect(t.of("token")[1].body).toEqual({ closingSessionId: "s1" });
    expect(t.sockets).toHaveLength(2);
    expect(t.sockets[1].sent).toHaveLength(0);
    t.sockets[1].open();
    t.audio.push(4);
    // … and sent first, in order, before live audio.
    expect(t.sockets[1].audioTags).toEqual([2, 3, 4]);
    expect(t.stream.state.state).toBe("live");

    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await settle();
    const posted = t.of("segments").flatMap((c) => c.body.segments);
    expect(posted).toEqual([
      { segmentIndex: 0, runIndex: 0, speaker: "speaker_0", text: "Hej där", startMs: 0, endMs: 900, elSessionId: "s1" },
    ]);
  });

  it("backs off 1 s, 2 s, 5 s, then every 5 s while the socket keeps failing", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    const gaps: number[] = [];
    let last = Date.now();
    for (let i = 0; i < 5; i++) {
      t.sockets.at(-1)!.drop();
      const before = t.sockets.length;
      while (t.sockets.length === before) await vi.advanceTimersByTimeAsync(100);
      gaps.push(Math.round((Date.now() - last) / 1000) * 1000);
      last = Date.now();
    }
    expect(gaps).toEqual([1000, 2000, 5000, 5000, 5000]);
  });

  it("a failed POST is retried, not dropped", async () => {
    const t = setup();
    t.replies.segments.push(json(500, { error: "boom" }), "network");
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.sockets[0].emit(diarized(3, [["Beslut", "speaker_1"]]));
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(FLUSH_MS);
      await settle();
    }
    const tries = t.of("segments");
    expect(tries).toHaveLength(3);
    expect(tries.map((c) => c.body.segments[0].text)).toEqual(["Beslut", "Beslut", "Beslut"]);
    expect(t.stream.pending).toBe(0);
  });

  it("429 on segments keeps the batch and backs off", async () => {
    const t = setup();
    t.replies.segments.push(json(429, { error: "rate_limited" }));
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.sockets[0].emit(diarized(0, [["a", "s"]]));
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await settle();
    expect(t.of("segments")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FLUSH_MS); // still inside the 5 s backoff
    await settle();
    expect(t.of("segments")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await settle();
    expect(t.of("segments")).toHaveLength(2);
    expect(t.stream.pending).toBe(0);
  });

  it("3 failed token requests → state 'error'", async () => {
    const t = setup();
    t.replies.token.push(json(502, { error: "mint_failed" }), json(502, { error: "mint_failed" }), json(409, { error: "session_open" }));
    await t.stream.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(t.of("token")).toHaveLength(3);
    expect(t.stream.state).toMatchObject({ state: "error", error: "token" });
    expect(t.sockets).toHaveLength(0);
    // Försök igen starts over.
    await t.stream.retry();
    await settle();
    expect(t.sockets).toHaveLength(1);
  });

  it("network failures (offline) do not count toward the 3", async () => {
    const t = setup();
    t.replies.token.push("network", "network", "network", "network");
    await t.stream.start();
    expect(t.stream.state).toMatchObject({ state: "reconnecting" });
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(t.of("token")).toHaveLength(5);
    expect(t.sockets).toHaveLength(1);
  });

  it("429 reconnect_limit → waits 5 s and retries without counting", async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) t.replies.token.push(json(429, { error: "reconnect_limit" }));
    await t.stream.start();
    await vi.advanceTimersByTimeAsync(4900);
    expect(t.of("token")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(11_000);
    await settle();
    expect(t.of("token")).toHaveLength(4);
    expect(t.sockets).toHaveLength(1);
  });

  it("a cap refusal is terminal (no retry loop)", async () => {
    const t = setup();
    t.replies.token.push(json(429, { error: "meeting_length" }));
    await t.stream.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.of("token")).toHaveLength(1);
    expect(t.stream.state).toMatchObject({ state: "error", error: "limit", refusal: "meeting_length" });
  });

  it("pause sends no audio and buffers none; resume streams again", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.audio.push(1);
    t.stream.pause();
    expect(t.stream.state.state).toBe("paused");
    expect(t.sockets[0].sent.at(-1)).toMatchObject({ commit: true });
    t.audio.push(2);
    t.audio.push(3);
    await settle();
    expect(t.of("pause")[0].body).toEqual({ paused: true });
    // A drop while paused mints nothing …
    t.sockets[0].drop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.of("token")).toHaveLength(1);
    t.audio.push(4);
    // … resume reconnects and never sends the paused audio.
    t.stream.resume();
    await settle();
    expect(t.of("token")).toHaveLength(2);
    t.sockets[1].open();
    t.audio.push(5);
    expect(t.sockets[0].audioTags).toEqual([1]);
    expect(t.sockets[1].audioTags).toEqual([5]);
    expect(t.of("pause")[1].body).toEqual({ paused: false });
  });

  it("a token that arrives after Paus is remembered, so the next mint closes that session", async () => {
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = t.fetchFn.getMockImplementation()!;
    t.fetchFn.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/token") && t.of("token").length === 0) await gate;
      return inner(url, init);
    });
    const started = t.stream.start();
    await settle();
    t.stream.pause(); // while the first mint is in flight
    release();
    await started;
    await settle();
    expect(t.sockets).toHaveLength(0); // not used while paused
    t.stream.resume();
    await settle();
    expect(t.of("token").map((c) => c.body)).toEqual([{}, { closingSessionId: "s1" }]);
    expect(t.sockets).toHaveLength(1);
  });

  it("keeps at most 60 s of audio during a reconnect", async () => {
    const t = setup();
    t.replies.token.push("network");
    await t.stream.start();
    for (let i = 0; i < 700; i++) t.audio.push(i);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    t.sockets[0].open();
    const tags = t.sockets[0].audioTags;
    expect(tags).toHaveLength(600);
    expect(tags[0]).toBe(100);
    expect(tags.at(-1)).toBe(699);
  });

  it("merges are sent after their runs", async () => {
    const t = setup();
    t.replies.segments.push(json(500));
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.sockets[0].emit(diarized(0, [["a", "speaker_2"]]));
    t.sockets[0].emit({ message_type: "speakers_merged", from_speaker_id: "speaker_2", to_speaker_id: "speaker_1" });
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await settle();
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await settle();
    const ok = t.of("segments")[1].body;
    expect(ok.segments).toHaveLength(1);
    expect(ok.merges).toEqual([{ elSessionId: "s1", from: ["speaker_2"], into: "speaker_1" }]);
  });

  it("heartbeat every 10 s; stop:true stops the stream (the server ends the meeting)", async () => {
    const t = setup();
    const beats: unknown[] = [];
    t.stream.on("heartbeat", (h) => beats.push(h));
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    expect(t.of("heartbeat")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await settle();
    expect(t.of("heartbeat")).toHaveLength(2);
    t.replies.heartbeat.push(json(200, { warn: true, stop: true }));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await settle();
    await vi.advanceTimersByTimeAsync(STOP_DRAIN_MS + 100);
    await settle();
    expect(beats.at(-1)).toEqual({ warn: true, stop: true });
    expect(t.stream.state).toMatchObject({ state: "stopped", autoStopped: true });
    expect(t.audio.stopped).toBe(true);
  });

  it("stop commits, waits for trailing events, posts everything, then closes", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    const done = t.stream.stop();
    expect(t.sockets[0].sent.at(-1)).toMatchObject({ commit: true });
    t.sockets[0].emit(diarized(9, [["Sista", "speaker_0"], ["ordet", "speaker_1"]]));
    await vi.advanceTimersByTimeAsync(STOP_DRAIN_MS);
    await settle();
    await done;
    expect(t.of("segments").flatMap((c) => c.body.segments).map((s: { text: string }) => s.text)).toEqual(["Sista", "ordet"]);
    expect(t.sockets[0].closedByClient).toBe(true);
    expect(t.stream.state.state).toBe("stopped");
  });

  it("mic permission denied → error mic-denied, no token minted", async () => {
    const t = setup();
    t.audio.error = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    await t.stream.start();
    expect(t.stream.state).toMatchObject({ state: "error", error: "mic-denied" });
    expect(t.of("token")).toHaveLength(0);
  });

  it("ignores events from an old socket after a reconnect", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    const old = t.sockets[0];
    old.drop();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    t.sockets[1].open();
    old.emit(diarized(0, [["spöke", "speaker_0"]]));
    old.onclose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.stream.pending).toBe(0);
    expect(t.sockets).toHaveLength(2);
  });

  // --- fix round 1: robustness -----------------------------------------------------------------

  it("409 session_open with the server's open session id → adopts it as closingSessionId (lost token response)", async () => {
    const t = setup();
    t.replies.token.push(json(409, { error: "session_open", openSessionId: "lost-session" }));
    await t.stream.start();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(t.of("token").map((c) => c.body)).toEqual([{}, { closingSessionId: "lost-session" }]);
    expect(t.sockets).toHaveLength(1);
    expect(t.stream.state.state).not.toBe("error");
  });

  it("heartbeat naming another current session → stops as superseded without draining", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.sockets[0].emit(diarized(0, [["mitt", "speaker_0"]]));
    // Our own session is current: nothing happens.
    t.replies.heartbeat.push(json(200, { warn: false, stop: false, currentElSessionId: "s1" }));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await settle();
    expect(t.stream.state.state).toBe("live");
    // Another tab took over.
    t.replies.heartbeat.push(json(200, { warn: false, stop: false, currentElSessionId: "other-tab" }));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(t.stream.state).toMatchObject({ state: "stopped", superseded: true });
    expect(t.audio.stopped).toBe(true);
    expect(t.sockets[0].sent.some((m) => m.commit === true)).toBe(false); // no drain commit
    expect(t.of("segments").flatMap((c) => c.body.segments).map((r: { text: string }) => r.text)).toEqual(["mitt"]);
  });

  it("401 on segments keeps the runs and reports authLost until a post succeeds", async () => {
    const t = setup();
    const health: unknown[] = [];
    t.stream.on("health", (h) => health.push(h));
    t.replies.segments.push(json(401, { error: "unauthenticated" }));
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.sockets[0].emit(diarized(0, [["kvar", "speaker_0"]]));
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.stream.pending).toBe(1);
    expect(health.at(-1)).toMatchObject({ authLost: true });
    await vi.advanceTimersByTimeAsync(12_000);
    await settle();
    expect(t.stream.pending).toBe(0);
    expect(t.of("segments").map((c) => c.body.segments[0].text)).toEqual(["kvar", "kvar"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(health.at(-1)).toMatchObject({ authLost: false });
  });

  it("a 400 on a batch retries the runs one by one, so only the bad one is dropped", async () => {
    const t = setup();
    t.replies.segments.push(json(400, { error: "bad_request" }), json(200), json(400, { error: "bad_request" }), json(200));
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.sockets[0].emit(diarized(0, [["ett", "a"], ["två", "b"], ["tre", "c"]]));
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(FLUSH_MS);
      await settle();
    }
    expect(t.of("segments").map((c) => c.body.segments.map((r: { text: string }) => r.text))).toEqual([
      ["ett", "två", "tre"],
      ["ett"],
      ["två"],
      ["tre"],
    ]);
    expect(t.stream.pending).toBe(0);
  });

  it("speaker labels are cut to 100 chars and endMs never precedes startMs", async () => {
    const t = setup();
    const runs: { speaker: string; startMs: number; endMs: number }[] = [];
    t.stream.on("runs", (r) => runs.push(...r));
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.sockets[0].emit({
      message_type: "diarized_transcript",
      segment_index: 0,
      words: [{ text: "x", start: 2, type: "word", speaker_id: "s".repeat(150) }],
    });
    expect(runs[0].speaker).toHaveLength(100);
    expect(runs[0].endMs).toBeGreaterThanOrEqual(runs[0].startMs);
  });

  it("a committed segment that never got diarized is posted as speaker 'unknown' when the socket drops", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    for (let i = 0; i < 20; i++) t.audio.push(i);
    t.sockets[0].emit({ message_type: "committed_transcript", segment_index: 0, text: "Diarized later." });
    t.sockets[0].emit(diarized(0, [["Diarized", "speaker_0"], ["later.", "speaker_0"]]));
    t.sockets[0].emit({ message_type: "committed_transcript", segment_index: 1, text: "Aldrig diarized." });
    t.sockets[0].drop();
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await settle();
    const posted = t.of("segments").flatMap((c) => c.body.segments);
    expect(posted.map((r: { text: string }) => r.text)).toEqual(["Diarized later.", "Aldrig diarized."]);
    expect(posted[1]).toMatchObject({ elSessionId: "s1", segmentIndex: 1, runIndex: 0, speaker: "unknown", endMs: 2000 });
  });

  it("…and on Stopp when the diarization doesn't come within the drain", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.sockets[0].emit({
      message_type: "committed_transcript_with_timestamps",
      segment_index: 4,
      text: "Sista meningen.",
      language_code: "sv",
      words: [{ text: "Sista", start: 1, end: 1.4, type: "word" }, { text: "meningen.", start: 1.5, end: 2, type: "word" }],
    });
    const done = t.stream.stop();
    await vi.advanceTimersByTimeAsync(STOP_DRAIN_MS);
    await settle();
    await done;
    expect(t.of("segments")[0].body.segments).toEqual([
      { elSessionId: "s1", segmentIndex: 4, runIndex: 0, speaker: "unknown", text: "Sista meningen.", startMs: 1000, endMs: 2000, lang: "sv" },
    ]);
  });

  it("no mic audio: asks the mic to recover after 5 s, tells the page after 10 s", async () => {
    const t = setup();
    const health: { audioStalled: boolean }[] = [];
    t.stream.on("health", (h) => health.push(h));
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.audio.push(1);
    await vi.advanceTimersByTimeAsync(AUDIO_STALL_MS + 1000);
    expect(t.audio.recovers).toEqual([1]);
    await vi.advanceTimersByTimeAsync(AUDIO_STALL_NOTICE_MS - AUDIO_STALL_MS);
    expect(t.audio.recovers).toEqual([1, 2]);
    expect(health.at(-1)).toMatchObject({ audioStalled: true });
    t.audio.push(2); // sound is back
    await vi.advanceTimersByTimeAsync(1000);
    expect(health.at(-1)).toMatchObject({ audioStalled: false });
  });

  it("a socket that stays silent while we send speech is treated as dropped", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    for (let s = 0; s < 61; s++) {
      for (let i = 0; i < 10; i++) t.audio.push(i, true);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(t.of("token").map((c) => c.body)).toEqual([{}, { closingSessionId: "s1" }]);
    expect(t.sockets).toHaveLength(2);
  });

  it("a silent room (no speech) never trips the socket watchdog", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    for (let s = 0; s < 40; s++) {
      for (let i = 0; i < 10; i++) t.audio.push(i);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(t.sockets).toHaveLength(1);
  });

  it("an unreadable 200 from the token route reconnects instead of hanging", async () => {
    const t = setup();
    t.replies.token.push(json(200, { nope: true }));
    await t.stream.start();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(t.of("token")).toHaveLength(2);
    expect(t.sockets).toHaveLength(1);
  });

  // --- fix round 2 ---------------------------------------------------------------------------

  it("a failed mint (server current moved on) + a heartbeat with another current id → NOT superseded, reconnects", async () => {
    const t = setup();
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    // The socket drops; the next mint is claimed on the server (current = "claimed-y") but fails.
    t.sockets[0].drop();
    t.replies.token.push(json(502, { error: "mint_failed" }));
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(t.of("token")).toHaveLength(2);
    // While we wait to retry, the heartbeat reports the claimed (closed) session as current.
    t.replies.heartbeat.push(json(200, { warn: false, stop: false, currentElSessionId: "claimed-y" }));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await settle();
    expect(t.stream.state.superseded).toBeUndefined();
    expect(t.stream.state.state).not.toBe("stopped");
    expect(t.audio.stopped).toBe(false);
    expect(t.sockets).toHaveLength(2); // reconnected after the backoff
    t.sockets[1].open();
    expect(t.stream.state.state).toBe("live");
  });

  it("a lost token response + a heartbeat naming that session → NOT superseded; the 409 adoption reconnects", async () => {
    const t = setup({ initialClosingSessionId: "x" }); // resumed after a reload: we hold "x"
    t.replies.token.push("network"); // the server claimed "lost-y", the response never arrived
    t.replies.token.push(json(409, { error: "session_open", openSessionId: "lost-y" }));
    t.replies.heartbeat.push(json(200, { warn: false, stop: false, currentElSessionId: "lost-y" }));
    await t.stream.start();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(t.stream.state.superseded).toBeUndefined();
    expect(t.of("token").map((c) => c.body)).toEqual([
      { closingSessionId: "x" },
      { closingSessionId: "x" },
      { closingSessionId: "lost-y" },
    ]);
    expect(t.sockets).toHaveLength(1);
  });

  it("403 not_starter on segments drops the runs and stops sending (not authLost)", async () => {
    const t = setup();
    const health: { authLost: boolean }[] = [];
    t.stream.on("health", (h) => health.push(h));
    t.replies.segments.push(json(403, { error: "not_starter" }));
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.sockets[0].emit(diarized(0, [["x", "s"]]));
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await settle();
    expect(t.stream.pending).toBe(0);
    expect(t.stream.state).toMatchObject({ state: "error", refusal: "not_starter" });
    expect(t.audio.stopped).toBe(true);
    expect(health.some((h) => h.authLost)).toBe(false);
  });

  it("postsFailing clears when the queue empties, not only on a successful post", async () => {
    const t = setup();
    const health: { postsFailing: boolean }[] = [];
    t.stream.on("health", (h) => health.push(h));
    for (let i = 0; i < 30; i++) t.replies.segments.push(json(500));
    t.replies.segments.push(json(400, { error: "bad_request" }));
    await t.stream.start();
    await settle();
    t.sockets[0].open();
    t.sockets[0].emit(diarized(0, [["x", "s"]]));
    for (let i = 0; i < 25; i++) {
      t.audio.push(i);
      await vi.advanceTimersByTimeAsync(FLUSH_MS);
      await settle();
    }
    expect(health.at(-1)).toMatchObject({ postsFailing: true });
    t.replies.segments.length = 0;
    t.replies.segments.push(json(400, { error: "bad_request" })); // the single run is dropped
    t.audio.push(0);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await settle();
    t.audio.push(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.stream.pending).toBe(0);
    expect(health.at(-1)).toMatchObject({ postsFailing: false });
  });

  describe("final fix wave (C1–C5, C12, D)", () => {
    it("C1: a hung segments POST times out after 15 s and is retried; the queue is kept", async () => {
      const t = setup();
      t.replies.segments.push("hang");
      await t.stream.start();
      await settle();
      t.sockets[0].open();
      t.sockets[0].emit(diarized(0, [["Hej", "speaker_0"]]));
      await vi.advanceTimersByTimeAsync(FLUSH_MS);
      await settle();
      expect(t.of("segments")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + FLUSH_MS);
      await settle();
      expect(t.of("segments").length).toBeGreaterThanOrEqual(2);
      expect(t.stream.pending).toBe(0);
    });

    it("C1/C6: Stopp with posts hanging resolves within the stop deadline and reports what is left", async () => {
      const t = setup();
      for (let i = 0; i < 20; i++) t.replies.segments.push("hang");
      const pending: number[] = [];
      t.stream.on("pending", (n) => pending.push(n));
      await t.stream.start();
      await settle();
      t.sockets[0].open();
      t.sockets[0].emit(diarized(0, [["Hej", "speaker_0"]]));
      let done = false;
      void t.stream.stop().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(STOP_DRAIN_MS + STOP_FLUSH_MAX_MS + FETCH_TIMEOUT_MS + 2000);
      await settle();
      expect(done).toBe(true);
      expect(t.stream.state.state).toBe("stopped");
      expect(t.stream.pending).toBe(1);
      expect(pending.at(-1)).toBe(1);
      // The page keeps draining afterwards; once the net answers, nothing is left.
      t.replies.segments.length = 0;
      expect(await t.stream.drain(5000)).toBe(0);
    });

    it("C1: a hung heartbeat does not block later heartbeats", async () => {
      const t = setup();
      t.replies.heartbeat.push("hang");
      await t.stream.start();
      await settle();
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + HEARTBEAT_MS);
      await settle();
      expect(t.of("heartbeat").length).toBeGreaterThanOrEqual(2);
    });

    it("C2: from 'error' (token) it retries every 30 s and keeps the audio meanwhile", async () => {
      const t = setup();
      t.replies.token.push(json(502, {}), json(502, {}), json(502, {}), json(502, {}));
      await t.stream.start();
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(t.stream.state).toMatchObject({ state: "error", error: "token" });
      const before = t.of("token").length;
      t.audio.push(41);
      t.audio.push(42);
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_MS);
      await settle();
      expect(t.of("token").length).toBe(before + 1); // still failing: back to error, no storm
      expect(t.stream.state.state).toBe("error");
      await vi.advanceTimersByTimeAsync(ERROR_RETRY_MS);
      await settle();
      expect(t.sockets).toHaveLength(1);
      t.sockets[0].open();
      expect(t.stream.state.state).toBe("live");
      expect(t.sockets[0].audioTags.slice(0, 2)).toEqual([41, 42]);
    });

    it("C3: loud audio long ago doesn't count; only speech within the last 60 s trips the silent-socket watchdog", async () => {
      const t = setup();
      await t.stream.start();
      await settle();
      t.sockets[0].open();
      for (let i = 0; i < 60; i++) t.audio.push(i, true); // 6 s of speech, then a quiet room
      for (let s = 0; s < 70; s++) {
        for (let i = 0; i < 10; i++) t.audio.push(i);
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(t.sockets).toHaveLength(1);
    });

    it("C4: a muted/ended mic track asks for recovery at once; 2 min below the heard level → quiet", async () => {
      const t = setup();
      const health: boolean[] = [];
      t.stream.on("health", (h) => health.push(h.quiet));
      await t.stream.start();
      await settle();
      t.sockets[0].open();
      // An ended track reopens the mic at once (resume can't bring it back); a muted one resumes first.
      t.audio.onProblem?.("ended");
      await settle();
      expect(t.audio.recovers).toEqual([2]);
      t.audio.push(0);
      t.audio.onProblem?.("muted");
      await settle();
      expect(t.audio.recovers).toEqual([2, 1]);
      for (let s = 0; s < QUIET_NOTICE_MS / 1000 + 2; s++) {
        for (let i = 0; i < 10; i++) t.audio.push(i);
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(health.at(-1)).toBe(true);
      t.audio.push(1, true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(health.at(-1)).toBe(false);
    });

    it("C5: quota_exceeded stops with error 'limit' (el_service); one auth_error doesn't, two in a row do", async () => {
      const a = setup();
      await a.stream.start();
      await settle();
      a.sockets[0].open();
      a.sockets[0].emit({ message_type: "quota_exceeded", error: "Quota exceeded" });
      expect(a.stream.state).toMatchObject({ state: "error", error: "limit", refusal: "el_service" });

      const b = setup();
      await b.stream.start();
      await settle();
      b.sockets[0].open();
      b.sockets[0].emit({ message_type: "auth_error", error: "bad token" });
      expect(b.stream.state.state).toBe("live");
      b.sockets[0].drop();
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      b.sockets[1].open();
      b.sockets[1].emit({ message_type: "auth_error", error: "bad token" });
      expect(b.stream.state).toMatchObject({ state: "error", error: "limit", refusal: "el_service" });
    });

    it("C12: audio waits for session_started (then goes in order); without it, after 3 s", async () => {
      const t = setup();
      await t.stream.start();
      await settle();
      t.sockets[0].openOnly();
      t.audio.push(1);
      t.audio.push(2);
      expect(t.sockets[0].audioTags).toEqual([]);
      t.sockets[0].emit({ message_type: "session_started", session_id: "x" });
      t.audio.push(3);
      expect(t.sockets[0].audioTags).toEqual([1, 2, 3]);

      t.sockets[0].drop();
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      t.sockets[1].openOnly();
      t.audio.push(4);
      await vi.advanceTimersByTimeAsync(SESSION_START_WAIT_MS);
      t.audio.push(5);
      expect(t.sockets[1].audioTags).toEqual([4, 5]);
    });

    it("C12: an error as the first message doesn't release the held audio into a dying socket", async () => {
      const t = setup();
      t.replies.token.push("network");
      await t.stream.start();
      t.audio.push(7);
      t.audio.push(8);
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      t.sockets[0].openOnly();
      t.sockets[0].emit({ message_type: "auth_error", error: "expired" });
      expect(t.sockets[0].audioTags).toEqual([]);
      t.sockets[0].drop();
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      t.sockets[1].open();
      expect(t.sockets[1].audioTags).toEqual([7, 8]);
    });

    it("D: an unknown message type is logged once", async () => {
      const lines: string[] = [];
      const t = setup({ log: (m) => lines.push(m) });
      await t.stream.start();
      await settle();
      t.sockets[0].open();
      for (let i = 0; i < 3; i++) t.sockets[0].emit({ message_type: "speaker_names", names: {} });
      expect(lines.filter((l) => l.includes("speaker_names"))).toHaveLength(1);
    });

    it("D: flushOnExit posts committed-but-undiarized segments too, with keepalive", async () => {
      const t = setup();
      await t.stream.start();
      await settle();
      t.sockets[0].open();
      t.sockets[0].emit({ message_type: "committed_transcript", segment_index: 3, text: "Sista meningen" });
      t.stream.flushOnExit();
      await settle();
      const posted = t.of("segments").flatMap((c) => c.body.segments);
      expect(posted).toEqual([expect.objectContaining({ segmentIndex: 3, speaker: "unknown", text: "Sista meningen" })]);
      const init = t.fetchFn.mock.calls.find((c) => String(c[0]).endsWith("/segments"))![1] as RequestInit;
      expect(init.keepalive).toBe(true);
    });
  });

  describe("residual fixes (R2, R3)", () => {
    it("R2: a session that dies within a minute → next attempt after 30 s, then 60 s; a long one resets", async () => {
      const t = setup({ shortSessionMs: 60_000 });
      await t.stream.start();
      await settle();
      t.sockets[0].open();
      t.sockets[0].drop(); // lived ~0 s
      expect(t.stream.state).toMatchObject({ state: "reconnecting" });
      expect(t.stream.state.retryAt! - Date.now()).toBe(30_000);
      await vi.advanceTimersByTimeAsync(29_000);
      await settle();
      expect(t.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(t.sockets).toHaveLength(2);
      t.sockets[1].open();
      t.sockets[1].drop(); // short again → 60 s
      expect(t.stream.state.retryAt! - Date.now()).toBe(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(t.sockets).toHaveLength(3);
      t.sockets[2].open();
      await vi.advanceTimersByTimeAsync(61_000); // lived over a minute
      t.sockets[2].drop();
      expect(t.stream.state.retryAt! - Date.now()).toBe(1000); // normal backoff again
    });

    it("R2: 429 reconnect_limit with retryAfter waits exactly that long, without counting as a failure", async () => {
      const t = setup();
      t.replies.token.push(json(429, { error: "reconnect_limit", retryAfter: 40 }), json(429, { error: "reconnect_limit", retryAfter: 80 }));
      await t.stream.start();
      await settle();
      expect(t.stream.state).toMatchObject({ state: "reconnecting" });
      expect(t.stream.state.retryAt! - Date.now()).toBe(40_000);
      await vi.advanceTimersByTimeAsync(40_000);
      await settle();
      expect(t.of("token")).toHaveLength(2);
      expect(t.stream.state.retryAt! - Date.now()).toBe(80_000);
      await vi.advanceTimersByTimeAsync(80_000);
      await settle();
      expect(t.sockets).toHaveLength(1);
      expect(t.stream.state.state).not.toBe("error");
    });

    it("R3: signed out while draining → drain stops at once instead of looping; signedOut says why", async () => {
      const t = setup();
      await t.stream.start();
      await settle();
      t.sockets[0].open();
      t.sockets[0].emit(diarized(0, [["Hej", "speaker_0"]]));
      t.replies.segments.push(json(401, { error: "unauthenticated" }));
      const left = t.stream.drain(STOP_FLUSH_MAX_MS);
      await settle();
      expect(await left).toBe(1);
      expect(t.of("segments")).toHaveLength(1);
      expect(t.stream.signedOut).toBe(true);
      // After signing in again the next drain posts it.
      expect(await t.stream.drain(5000)).toBe(0);
      expect(t.stream.signedOut).toBe(false);
    });
  });
});
