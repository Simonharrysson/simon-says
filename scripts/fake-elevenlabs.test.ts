// LiveStream against the fake ElevenLabs server over a real WebSocket (Node's built-in client).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SegmentIn } from "@/lib/segments/types";
import { LiveStream, type AudioSource, type SocketLike } from "@/lib/audio/stream";
import { startFakeElevenLabs, type FakeServer } from "./fake-elevenlabs";

class PushAudio implements AudioSource {
  onChunk: ((pcm: Int16Array) => void) | null = null;
  async start(onChunk: (pcm: Int16Array) => void) {
    this.onChunk = onChunk;
  }
  stop() {
    this.onChunk = null;
  }
  push(chunks: number) {
    for (let i = 0; i < chunks; i++) this.onChunk?.(new Int16Array(1600).fill(i % 2 ? 1000 : -1000));
  }
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let fake: FakeServer | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe("LiveStream ↔ fake ElevenLabs", () => {
  it("streams, survives a dropped socket and posts every diarized run with its own session id", { timeout: 20_000 }, async () => {
    fake = await startFakeElevenLabs({ port: 0, segmentSeconds: 2, log: () => {} });
    const posted: SegmentIn[] = [];
    const tokenBodies: unknown[] = [];
    let n = 0;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("/").at(-1);
      if (path === "token") {
        tokenBodies.push(JSON.parse(String(init?.body)));
        n++;
        return Response.json({ token: `fake-${n}`, wsUrl: `${fake!.url}?model_id=scribe_v3_live&audio_format=pcm_16000&diarize=true`, sessionId: `s${n}` });
      }
      if (path === "segments") {
        posted.push(...JSON.parse(String(init?.body)).segments);
        return Response.json({ stored: 1, received: 1 });
      }
      return Response.json({ warn: false, stop: false });
    });
    const audio = new PushAudio();
    const partials: string[] = [];
    const stream = new LiveStream({
      meetingId: "m",
      audio,
      fetch: fetchFn as unknown as typeof fetch,
      createSocket: (u) => new WebSocket(u) as unknown as SocketLike,
    });
    stream.on("partial", (t) => partials.push(t));
    const seen: SegmentIn[] = [];
    stream.on("runs", (r) => seen.push(...r));
    await stream.start();
    await waitFor(() => stream.state.state === "live");

    audio.push(25); // 2.5 s → one segment
    await waitFor(() => seen.some((r) => r.elSessionId === "s1"));

    fake.dropAll();
    await waitFor(() => stream.state.state === "reconnecting");
    audio.push(25); // held in the browser during the gap
    await waitFor(() => stream.state.state === "live");
    await waitFor(() => seen.some((r) => r.elSessionId === "s2")); // the held audio made a segment on session 2

    await stream.stop();
    expect(tokenBodies).toEqual([{}, { closingSessionId: "s1" }]);
    expect(fake.sessions()).toBe(2);
    expect(partials.length).toBeGreaterThan(0);
    const bySession = new Set(posted.map((s) => s.elSessionId));
    expect(bySession).toEqual(new Set(["s1", "s2"]));
    expect(posted[0]).toMatchObject({ elSessionId: "s1", segmentIndex: 0, runIndex: 0, speaker: "speaker_0" });
    // Session 2 restarts segment indexes, keyed by its own session id.
    expect(posted.find((s) => s.elSessionId === "s2")).toMatchObject({ segmentIndex: 0 });
    expect(stream.pending).toBe(0);
  });

  it("refuses a connection without a token or with the wrong format", async () => {
    fake = await startFakeElevenLabs({ port: 0, log: () => {} });
    const msgs: string[] = [];
    const ws = new WebSocket(`${fake.url}?model_id=scribe_v3_live&audio_format=mp3&token=x`);
    ws.onmessage = (e) => msgs.push(String(e.data));
    await new Promise((r) => (ws.onclose = r));
    expect(JSON.parse(msgs[0])).toMatchObject({ message_type: "input_error" });
  });
});
