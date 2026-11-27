// A video call's audio: the shared call tab (getDisplayMedia) and the user's mic, one
// AudioContext, a two-input worklet (public/call-worklet.js) → per-source levels for the
// "Du" / "Samtalet" meters → mixBlocks → 16 kHz PCM16 blocks of 1600 samples, exactly what
// MicCapture gives the stream. Browser only. The room path (capture.ts) is untouched.
import { CALL_MIC_CONSTRAINTS, classifyDisplayStream, DISPLAY_OPTIONS, floatLevel, mixBlocks, type DisplayCheck } from "./call";
import { resumeWithin } from "./capture";
import { resampleTo16kPcm16 } from "./resample";
import type { AudioSource } from "./stream";

export interface CallLevels {
  /** The user's own mic ("Du"), 0–1. */
  mic: number;
  /** The call tab ("Samtalet"), 0–1; null while no tab is shared. */
  call: number | null;
}

/** The share picker's outcome. "cancelled": closed without picking; "mic": the mic failed (error inside). */
export type ShareResult = { ok: true } | { ok: false; reason: Exclude<DisplayCheck, { ok: true }>["reason"] | "cancelled" | "mic" | "failed"; error?: unknown };

type CaptureControllerLike = { setFocusBehavior?: (b: string) => void };

export class CallCapture implements AudioSource {
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private display: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private callNode: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private opening: Promise<void> | null = null;
  /** Tab tracks whose "ended" is already listened to (open() re-attaches after a recover). */
  private watched = new WeakSet<MediaStreamTrack>();
  private onChunk: ((pcm: Int16Array) => void) | null = null;
  /** The meters on the start screen (set by the page; null stops reporting). */
  onLevels: ((levels: CallLevels) => void) | null = null;
  /** The mic track ended or was muted (set by LiveStream: it recovers the mic). */
  onProblem: ((why: string) => void) | null = null;
  /** The call tab stopped being shared (closed, "Sluta dela"): the page pauses and asks to share again. */
  onCallEnded: (() => void) | null = null;

  /** A tab is shared right now and its audio track is live. */
  get sharing(): boolean {
    return Boolean(this.display?.getAudioTracks().some((t) => t.readyState === "live"));
  }

  /**
   * Open the share picker. Call it straight from a click, before anything else is awaited:
   * getDisplayMedia needs the click's user activation, and the AudioContext is resumed from the
   * same click (Safari's rule, harmless elsewhere). Then the mic and the worklet, if not yet open.
   * Also used to share again after the tab was closed: the new tab replaces the old one.
   */
  share(): Promise<ShareResult> {
    const md = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!md?.getDisplayMedia) return Promise.resolve({ ok: false, reason: "failed" });
    const Controller = (globalThis as unknown as { CaptureController?: new () => CaptureControllerLike }).CaptureController;
    const controller = Controller ? new Controller() : null;
    const picked = md.getDisplayMedia({ ...DISPLAY_OPTIONS, ...(controller ? { controller } : {}) } as DisplayMediaStreamOptions);
    let ctx: AudioContext;
    try {
      ctx = this.context();
    } catch (e) {
      void picked.then((s) => s.getTracks().forEach((t) => t.stop()), () => {});
      return Promise.resolve({ ok: false, reason: "failed", error: e });
    }
    return (async (): Promise<ShareResult> => {
      let stream: MediaStream;
      try {
        stream = await picked;
      } catch (e) {
        const name = (e as { name?: string } | null)?.name;
        return { ok: false, reason: name === "NotAllowedError" || name === "AbortError" ? "cancelled" : "failed", error: e };
      }
      // Stay on this page after picking (the meters and Start are here), where Chrome allows it.
      try {
        controller?.setFocusBehavior?.("no-focus-change");
      } catch {
        // Not supported, or too late: Chrome switches to the shared tab; the user comes back.
      }
      const check = classifyDisplayStream(stream);
      if (!check.ok) return { ok: false, reason: check.reason };
      try {
        await this.open();
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        return { ok: false, reason: "mic", error: e };
      }
      if (this.ctx !== ctx) {
        // Stopped while the picker was open.
        stream.getTracks().forEach((t) => t.stop());
        return { ok: false, reason: "cancelled" };
      }
      this.attachCall(stream, check.audio);
      return { ok: true };
    })();
  }

  /** The AudioContext, created (and resumed) synchronously so a click's activation still counts. */
  private context(): AudioContext {
    if (this.ctx && this.ctx.state !== "closed") {
      if (this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) throw Object.assign(new Error("no audio capture in this browser"), { name: "NotFoundError" });
    const ctx = new Ctx();
    void ctx.resume().catch(() => {});
    this.ctx = ctx;
    this.opening = null;
    return ctx;
  }

  /** The mic and the worklet (no tab yet). Idempotent; a failed open can be retried. */
  open(): Promise<void> {
    if (this.opening) return this.opening;
    if (!navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(Object.assign(new Error("no audio capture in this browser"), { name: "NotFoundError" }));
    }
    const ctx = this.context();
    this.opening = (async () => {
      await ctx.audioWorklet.addModule("/call-worklet.js");
      const node = new AudioWorkletNode(ctx, "call-blocks", { numberOfInputs: 2, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (ev: MessageEvent<{ mic: Float32Array; call: Float32Array }>) => this.block(ev.data.mic, ev.data.call, ctx.sampleRate);
      // The worklet only runs while connected to the output; a zero gain keeps it silent.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      this.node = node;
      await this.openMic(ctx);
      if (this.display && this.sharing) this.attachCall(this.display, this.display.getAudioTracks()[0]);
      if (ctx.state === "suspended") await resumeWithin(ctx);
    })().catch((e) => {
      this.closeGraph();
      throw e;
    });
    return this.opening;
  }

  private async openMic(ctx: AudioContext): Promise<void> {
    const media = await navigator.mediaDevices.getUserMedia(CALL_MIC_CONSTRAINTS);
    if (this.ctx !== ctx || !this.node) {
      media.getTracks().forEach((t) => t.stop());
      return;
    }
    this.mic?.getTracks().forEach((t) => t.stop());
    this.micNode?.disconnect();
    this.mic = media;
    for (const track of media.getAudioTracks()) {
      track.addEventListener("ended", () => this.mic === media && this.onProblem?.("ended"));
      track.addEventListener("mute", () => this.mic === media && this.onProblem?.("muted"));
    }
    const source = ctx.createMediaStreamSource(media);
    source.connect(this.node, 0, 0);
    this.micNode = source;
  }

  /** Put a shared tab on the worklet's second input (replacing an earlier one). */
  private attachCall(stream: MediaStream, audio: MediaStreamTrack): void {
    if (this.display && this.display !== stream) this.display.getTracks().forEach((t) => t.stop());
    this.callNode?.disconnect();
    this.callNode = null;
    this.display = stream;
    // Only the end matters: a tab's audio "mutes" whenever the call is silent.
    if (!this.watched.has(audio)) {
      this.watched.add(audio);
      audio.addEventListener("ended", () => this.display === stream && this.onCallEnded?.());
    }
    if (!this.ctx || !this.node) return; // open() attaches it once the graph is up
    const source = this.ctx.createMediaStreamSource(new MediaStream([audio]));
    source.connect(this.node, 0, 1);
    this.callNode = source;
  }

  private block(mic: Float32Array, call: Float32Array, rate: number): void {
    const sharing = this.callNode !== null;
    this.onLevels?.({ mic: floatLevel(mic), call: sharing ? floatLevel(call) : null });
    if (!this.onChunk) return;
    this.onChunk(resampleTo16kPcm16(mixBlocks(mic, sharing ? call : null), rate));
  }

  async start(onChunk: (pcm: Int16Array) => void): Promise<void> {
    await this.open();
    this.onChunk = onChunk;
  }

  /**
   * No blocks are arriving (lid closed, the context suspended) or the mic went away. Attempt 1:
   * resume. Later: rebuild the context and the mic, but keep the shared tab: it can't be picked
   * again without a click, and its track is still good.
   */
  async recover(attempt: number): Promise<void> {
    const ctx = this.ctx;
    if (attempt <= 1 && ctx && ctx.state !== "closed" && (await resumeWithin(ctx))) return;
    const onChunk = this.onChunk;
    this.closeGraph();
    await this.open();
    this.onChunk = onChunk;
  }

  /** The start screen's meters are done (the stream reports the level from now on). */
  stopCheck(): void {
    this.onLevels = null;
  }

  /** Tear down the context and the mic; the shared tab survives (see recover). */
  private closeGraph(): void {
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.micNode?.disconnect();
    this.callNode?.disconnect();
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.node = null;
    this.micNode = null;
    this.callNode = null;
    this.mic = null;
    this.ctx = null;
    this.opening = null;
  }

  stop(): void {
    this.onChunk = null;
    this.onLevels = null;
    this.closeGraph();
    this.display?.getTracks().forEach((t) => t.stop());
    this.display = null;
  }
}
