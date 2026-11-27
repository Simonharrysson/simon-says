import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_MIC_CONSTRAINTS, classifyDisplayStream, DISPLAY_OPTIONS, floatLevel, mixBlocks, tabAudioSupport } from "./call";
import { CallCapture, type CallLevels } from "./call-capture";

const f32 = (...v: number[]) => Float32Array.from(v);

describe("mixBlocks", () => {
  it("sums the mic and the call sample by sample", () => {
    expect([...mixBlocks(f32(0.25, -0.5, 0), f32(0.25, 0.25, -0.5))]).toEqual([0.5, -0.25, -0.5]);
  });

  it("clamps to -1…1 instead of wrapping", () => {
    expect([...mixBlocks(f32(0.75, -0.75), f32(0.5, -0.5))]).toEqual([1, -1]);
  });

  it("a missing or shorter side counts as silence (no tab shared, tab closed)", () => {
    expect([...mixBlocks(f32(0.5, 0.25), null)]).toEqual([0.5, 0.25]);
    expect([...mixBlocks(null, f32(0.5))]).toEqual([0.5]);
    expect([...mixBlocks(f32(0.5, 0.5), f32(0.25))]).toEqual([0.75, 0.5]);
    expect(mixBlocks(null, null).length).toBe(0);
  });
});

describe("floatLevel", () => {
  it("0 for silence, the rmsLevel scale (rms × 5, max 1) otherwise", () => {
    expect(floatLevel(new Float32Array(1600))).toBe(0);
    expect(floatLevel(null)).toBe(0);
    expect(floatLevel(new Float32Array(1600).fill(0.1))).toBeCloseTo(0.5);
    expect(floatLevel(new Float32Array(1600).fill(0.9))).toBe(1);
  });
});

type FakeTrack = { kind: string; readyState: MediaStreamTrackState; stop: ReturnType<typeof vi.fn<() => void>>; getSettings?: () => { displaySurface?: string } };
const track = (kind: string, surface?: string): FakeTrack => {
  const t: FakeTrack = { kind, readyState: "live", stop: vi.fn<() => void>(() => void (t.readyState = "ended")) };
  if (surface) t.getSettings = () => ({ displaySurface: surface });
  return t;
};

describe("classifyDisplayStream (no-audio-track detection)", () => {
  it("a tab with Dela flikljud: ok, the video track is stopped at once, the audio kept", () => {
    const video = track("video", "browser");
    const audio = track("audio");
    const r = classifyDisplayStream({ getTracks: () => [video, audio] });
    expect(r).toEqual({ ok: true, audio });
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
  });

  it("a tab without Dela flikljud: no-audio, and every track is stopped (the share bar goes away)", () => {
    const video = track("video", "browser");
    expect(classifyDisplayStream({ getTracks: () => [video] })).toEqual({ ok: false, reason: "no-audio" });
    expect(video.stop).toHaveBeenCalled();
  });

  it("a window or the whole screen: not-tab", () => {
    expect(classifyDisplayStream({ getTracks: () => [track("video", "window")] })).toEqual({ ok: false, reason: "not-tab" });
    expect(classifyDisplayStream({ getTracks: () => [track("video", "monitor")] })).toEqual({ ok: false, reason: "not-tab" });
  });

  it("an audio track that already ended counts as none", () => {
    const audio = track("audio");
    audio.readyState = "ended";
    expect(classifyDisplayStream({ getTracks: () => [track("video"), audio] })).toEqual({ ok: false, reason: "no-audio" });
  });
});

describe("tabAudioSupport", () => {
  const md = { getDisplayMedia: () => {} };
  const UA = {
    chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
    android: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1",
  };

  it("desktop Chrome and Edge can share tab audio", () => {
    expect(tabAudioSupport({ userAgent: UA.chrome, mediaDevices: md })).toBe("ok");
    expect(tabAudioSupport({ userAgent: UA.edge, mediaDevices: md })).toBe("ok");
  });

  it("Safari and Firefox share no tab audio, even with getDisplayMedia", () => {
    expect(tabAudioSupport({ userAgent: UA.safari, mediaDevices: md })).toBe("browser");
    expect(tabAudioSupport({ userAgent: UA.firefox, mediaDevices: md })).toBe("browser");
    expect(tabAudioSupport({ userAgent: UA.chrome, mediaDevices: {} })).toBe("browser");
  });

  it("phones can't share a tab", () => {
    expect(tabAudioSupport({ userAgent: UA.android, mediaDevices: md })).toBe("device");
    expect(tabAudioSupport({ userAgent: UA.iphone, mediaDevices: md })).toBe("device");
  });
});

describe("call capture settings", () => {
  it("echo cancellation on the mic; the tab keeps playing locally; Chrome's required video asked for", () => {
    expect((CALL_MIC_CONSTRAINTS.audio as MediaTrackConstraints).echoCancellation).toBe(true);
    expect((DISPLAY_OPTIONS.audio as { suppressLocalAudioPlayback?: boolean }).suppressLocalAudioPlayback).toBe(false);
    expect(DISPLAY_OPTIONS.video).toBeTruthy();
  });
});

// --- CallCapture: the mixer graph with a fake Web Audio ---------------------------------------

class FakeNode {
  connections: { to: unknown; out: number; input: number }[] = [];
  connect(to: unknown, out = 0, input = 0) {
    this.connections.push({ to, out, input });
    return to;
  }
  disconnect() {
    this.connections = [];
  }
}

function fakeWebAudio(display: { tracks: FakeTrack[] }) {
  const worklets: (FakeNode & { name: string; opts: { numberOfInputs: number }; port: { onmessage: ((ev: { data: unknown }) => void) | null } })[] = [];
  const sources: (FakeNode & { stream: { id: string } })[] = [];
  const micTrack = Object.assign(track("audio"), { addEventListener: vi.fn() });
  const getUserMedia = vi.fn(async () => ({ id: "mic", getTracks: () => [micTrack], getAudioTracks: () => [micTrack] }));
  const listeners = new Map<string, () => void>();
  const tabAudio = display.tracks.find((t) => t.kind === "audio") as (FakeTrack & { addEventListener?: unknown }) | undefined;
  if (tabAudio) tabAudio.addEventListener = (type: string, cb: () => void) => listeners.set(type, cb);
  const displayStream = {
    id: "display",
    getTracks: () => display.tracks,
    getAudioTracks: () => display.tracks.filter((t) => t.kind === "audio"),
  };
  const getDisplayMedia = vi.fn(async () => displayStream);
  class Ctx {
    state = "running";
    sampleRate = 48_000;
    destination = new FakeNode();
    audioWorklet = { addModule: vi.fn(async () => {}) };
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {});
    createGain() {
      return Object.assign(new FakeNode(), { gain: { value: 1 } });
    }
    createMediaStreamSource(stream: { id: string }) {
      const s = Object.assign(new FakeNode(), { stream });
      sources.push(s);
      return s;
    }
  }
  class Worklet extends FakeNode {
    port = { onmessage: null as ((ev: { data: unknown }) => void) | null };
    constructor(
      _ctx: unknown,
      public name: string,
      public opts: { numberOfInputs: number },
    ) {
      super();
      worklets.push(this);
    }
  }
  class FakeMediaStream {
    id = "tab-audio";
    constructor(public tracks: unknown[]) {}
  }
  vi.stubGlobal("window", { AudioContext: Ctx });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, getDisplayMedia } });
  vi.stubGlobal("AudioWorkletNode", Worklet);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  return { worklets, sources, getUserMedia, getDisplayMedia, endTab: () => listeners.get("ended")?.() };
}

describe("CallCapture (the mixer)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mic → worklet input 0, the shared tab → input 1; the chunk is both mixed, the meters each", async () => {
    const tab = [track("video", "browser"), track("audio")];
    const fake = fakeWebAudio({ tracks: tab });
    const cap = new CallCapture();
    const levels: CallLevels[] = [];
    cap.onLevels = (l) => levels.push(l);

    expect(await cap.share()).toEqual({ ok: true });
    expect(fake.getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(fake.getUserMedia).toHaveBeenCalledWith(CALL_MIC_CONSTRAINTS);
    expect(tab[0].stop).toHaveBeenCalled(); // video discarded
    expect(cap.sharing).toBe(true);

    const [worklet] = fake.worklets;
    expect(worklet.name).toBe("call-blocks");
    expect(worklet.opts.numberOfInputs).toBe(2);
    const mic = fake.sources.find((s) => s.stream.id === "mic")!;
    const call = fake.sources.find((s) => s.stream.id === "tab-audio")!;
    expect(mic.connections).toEqual([{ to: worklet, out: 0, input: 0 }]);
    expect(call.connections).toEqual([{ to: worklet, out: 0, input: 1 }]);

    const chunks: Int16Array[] = [];
    await cap.start((pcm) => chunks.push(pcm));
    // 100 ms at 48 kHz: the mic says 0.1, the call says 0.2 → 0.3 after mixing, 1600 samples.
    worklet.port.onmessage!({ data: { mic: new Float32Array(4800).fill(0.1), call: new Float32Array(4800).fill(0.2) } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1600);
    expect(chunks[0][800] / 32767).toBeCloseTo(0.3, 3);
    expect(levels.at(-1)!.mic).toBeCloseTo(0.5);
    expect(levels.at(-1)!.call).toBeCloseTo(1);
  });

  it("the tab closing calls onCallEnded once; sharing again replaces the tab on input 1", async () => {
    const tab = [track("video", "browser"), track("audio")];
    const fake = fakeWebAudio({ tracks: tab });
    const cap = new CallCapture();
    const ended = vi.fn();
    cap.onCallEnded = ended;
    await cap.share();
    tab[1].readyState = "ended";
    fake.endTab();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(cap.sharing).toBe(false);

    tab[1].readyState = "live";
    expect(await cap.share()).toEqual({ ok: true });
    const worklet = fake.worklets[0];
    const calls = fake.sources.filter((s) => s.stream.id === "tab-audio");
    expect(calls).toHaveLength(2);
    expect(calls[0].connections).toEqual([]);
    expect(calls[1].connections).toEqual([{ to: worklet, out: 0, input: 1 }]);
    expect(fake.getUserMedia).toHaveBeenCalledTimes(1); // the mic stays open
  });

  it("no audio track: nothing is opened, the reason comes back", async () => {
    const fake = fakeWebAudio({ tracks: [track("video", "browser")] });
    const cap = new CallCapture();
    expect(await cap.share()).toEqual({ ok: false, reason: "no-audio" });
    expect(fake.getUserMedia).not.toHaveBeenCalled();
    expect(cap.sharing).toBe(false);
  });

  it("closing the picker is 'cancelled', not an error", async () => {
    const fake = fakeWebAudio({ tracks: [] });
    fake.getDisplayMedia.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    const r = await new CallCapture().share();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("cancelled");
  });

  it("recover() rebuilds the mic but keeps the shared tab (it can't be picked again without a click)", async () => {
    const tab = [track("video", "browser"), track("audio")];
    const fake = fakeWebAudio({ tracks: tab });
    const cap = new CallCapture();
    await cap.share();
    await cap.recover(2);
    expect(fake.getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(fake.getUserMedia).toHaveBeenCalledTimes(2);
    expect(tab[1].stop).not.toHaveBeenCalled();
    const worklet = fake.worklets.at(-1)!;
    expect(fake.sources.filter((s) => s.stream.id === "tab-audio").at(-1)!.connections).toEqual([{ to: worklet, out: 0, input: 1 }]);
  });
});
