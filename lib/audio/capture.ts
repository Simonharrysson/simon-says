// Browser mic capture: getUserMedia → AudioWorklet (public/pcm-worklet.js, 100 ms blocks at
// the context's native rate) → 16 kHz PCM16 blocks of exactly 1600 samples. Browser only.
import { resampleTo16kPcm16, rmsLevel } from "./resample";
import type { AudioSource } from "./stream";

/** Safari can leave ctx.resume() pending forever after an interruption: give up after this. */
export const RESUME_TIMEOUT_MS = 5000;

/** Resume an AudioContext, but never wait more than `ms`. True if it is running afterwards. */
export async function resumeWithin(ctx: Pick<AudioContext, "resume" | "state">, ms = RESUME_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ms);
  });
  try {
    const result = await Promise.race([ctx.resume().then(() => "resumed" as const), timeout]);
    return result === "resumed" && ctx.state === "running";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Settings from the spike: raw room sound, but let the browser level the gain. */
const CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
};

export class MicCapture implements AudioSource {
  private ctx: AudioContext | null = null;
  private media: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private opening: Promise<void> | null = null;
  private onChunk: ((pcm: Int16Array) => void) | null = null;
  private onLevel: ((level: number) => void) | null = null;
  /** Called when the mic track ends or is muted (set by LiveStream). */
  onProblem: ((why: string) => void) | null = null;

  /**
   * Ask for the mic. Call it straight from a click handler: the AudioContext is created and
   * resumed synchronously (Safari only lets audio run when started from a user gesture), then
   * the permission prompt follows. Idempotent; a failed open can be retried.
   */
  open(): Promise<void> {
    if (this.opening) {
      // Opened earlier (the consent tick's mic check): Safari may have suspended the context
      // since (lock screen, a call). Resume it now, inside this click; later is too late.
      if (this.ctx && this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
      return this.opening;
    }
    const Ctx: typeof AudioContext | undefined =
      typeof window === "undefined"
        ? undefined
        : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctx || !navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(Object.assign(new Error("no audio capture in this browser"), { name: "NotFoundError" }));
    }
    const ctx = new Ctx();
    const resumed = ctx.resume().catch(() => {});
    this.ctx = ctx;
    this.opening = (async () => {
      const media = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
      this.media = media;
      // A dead mic (unplugged, taken by another app, OS mute) would otherwise only show as silence.
      for (const track of media.getAudioTracks()) {
        track.addEventListener("ended", () => this.media === media && this.onProblem?.("ended"));
        track.addEventListener("mute", () => this.media === media && this.onProblem?.("muted"));
      }
      await resumed;
      await ctx.audioWorklet.addModule("/pcm-worklet.js");
      const source = ctx.createMediaStreamSource(media);
      const node = new AudioWorkletNode(ctx, "pcm-blocks", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        const pcm = resampleTo16kPcm16(ev.data, ctx.sampleRate);
        this.onLevel?.(rmsLevel(pcm));
        this.onChunk?.(pcm);
      };
      // The worklet only runs while connected to the output; a zero gain keeps the room silent.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute).connect(ctx.destination);
      this.node = node;
      if (ctx.state === "suspended") await resumeWithin(ctx);
    })().catch((e) => {
      this.stop();
      throw e;
    });
    return this.opening;
  }

  /** Mic check before Start: level 0–1 per 100 ms block. */
  async check(onLevel: (level: number) => void): Promise<void> {
    this.onLevel = onLevel;
    await this.open();
  }

  async start(onChunk: (pcm: Int16Array) => void): Promise<void> {
    await this.open();
    this.onChunk = onChunk;
  }

  /**
   * The watchdog saw no blocks for a while (lid closed, Safari "interrupted" the context, the mic
   * went away). Attempt 1: resume the AudioContext. Later attempts: reopen the mic and context
   * (outside a click Safari may refuse; the page then shows that no sound arrives).
   */
  async recover(attempt: number): Promise<void> {
    const ctx = this.ctx;
    // Attempt 1: resume, but a resume Safari leaves hanging (interrupted) falls through to a reopen.
    if (attempt <= 1 && ctx && ctx.state !== "closed" && (await resumeWithin(ctx))) return;
    const onChunk = this.onChunk;
    const onLevel = this.onLevel;
    this.stop();
    await this.open();
    this.onChunk = onChunk;
    this.onLevel = onLevel;
  }

  /** End the consent-step mic check (the stream reports the level from now on). */
  stopCheck(): void {
    this.onLevel = null;
  }

  stop(): void {
    this.onChunk = null;
    this.onLevel = null;
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.media?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.node = null;
    this.media = null;
    this.ctx = null;
    this.opening = null;
  }
}
