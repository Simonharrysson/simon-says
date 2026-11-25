import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64ToPcm16 } from "./resample";
import {
  FLUSH_MS,
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
  open() {
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
  stopped = false;
  error: Error | null = null;
  async start(onChunk: (pcm: Int16Array) => void) {
    if (this.error) throw this.error;
    this.onChunk = onChunk;
  }
  stop() {
    this.stopped = true;
  }
  /** Push one 100 ms chunk whose first sample is `tag`. */
  push(tag: number) {
    const pcm = new Int16Array(1600);
    pcm[0] = tag;
    this.onChunk?.(pcm);
  }
}

type Reply = { status: number; body?: unknown } | "network";
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
    const r = reply;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetchFn, replies, calls, of: (path: string) => calls.filter((c) => c.path === path) };
}

function setup(opts: { initialClosingSessionId?: string | null } = {}) {
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
});
