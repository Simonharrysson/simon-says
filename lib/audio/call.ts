// A meeting held in a video call (Google Meet, Teams, Zoom in the browser): the call tab's audio
// (getDisplayMedia, "Dela flikljud") mixed with the user's own mic. Nobody joins the call and
// nothing shows to the other participants. Pure helpers here; the capture itself is
// call-capture.ts. Runs in the browser and in tests.

/** Where the meeting happens: around a table (the laptop's mic) or in a video call. */
export type CaptureSource = "room" | "call";

/**
 * Whether this browser can capture a tab's audio. Only desktop Chromium (Chrome, Edge, Brave,
 * Opera…) offers "Dela flikljud"; Safari and Firefox have getDisplayMedia but never give audio,
 * and phones can't share a tab at all.
 */
export type TabAudioSupport = "ok" | "browser" | "device";

export function tabAudioSupport(nav: { userAgent?: string; mediaDevices?: { getDisplayMedia?: unknown } } | undefined): TabAudioSupport {
  const ua = nav?.userAgent ?? "";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return "device";
  if (typeof nav?.mediaDevices?.getDisplayMedia !== "function") return "browser";
  // Chrome on iOS (CriOS) and Edge on iOS are Safari underneath; Firefox says "Firefox".
  if (/Firefox|FxiOS|CriOS|EdgiOS/.test(ua)) return "browser";
  return /\b(Chrome|Chromium|Edg)\//.test(ua) ? "ok" : "browser";
}

/** What getDisplayMedia handed back, and whether it is usable as the call's audio. */
export type DisplayCheck =
  | { ok: true; audio: MediaStreamTrack }
  /** "no-audio": a tab without "Dela flikljud" ticked; "not-tab": a window or the whole screen (no audio either). */
  | { ok: false; reason: "no-audio" | "not-tab" };

type TrackLike = Pick<MediaStreamTrack, "kind" | "readyState" | "stop"> & {
  getSettings?: () => { displaySurface?: string };
};

/**
 * Check a getDisplayMedia stream and tidy it up. The video track is only there because Chrome
 * requires one: it is stopped at once either way. Without a live audio track every track is
 * stopped too (that also takes Chrome's "sharing this tab" bar away), and the reason says what
 * to tell the user.
 */
export function classifyDisplayStream(stream: { getTracks(): TrackLike[] }): DisplayCheck {
  const tracks = stream.getTracks();
  const video = tracks.find((t) => t.kind === "video");
  const surface = video?.getSettings?.().displaySurface;
  const audio = tracks.find((t) => t.kind === "audio" && t.readyState === "live");
  for (const t of tracks) if (t.kind === "video") t.stop();
  if (audio) return { ok: true, audio: audio as MediaStreamTrack };
  for (const t of tracks) t.stop();
  return { ok: false, reason: surface && surface !== "browser" ? "not-tab" : "no-audio" };
}

/**
 * The call's audio and the user's mic, one 100 ms block each at the same rate, summed into one
 * block (what the STT pipeline gets). Summed, not averaged: the other side shouldn't be half as
 * loud while you are quiet. Clamped to -1…1; a missing or shorter block counts as silence.
 */
export function mixBlocks(mic: Float32Array | null, call: Float32Array | null): Float32Array {
  const n = Math.max(mic?.length ?? 0, call?.length ?? 0);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = (mic?.[i] ?? 0) + (call?.[i] ?? 0);
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

/** Loudness 0–1 of float samples, on the same scale as resample.ts rmsLevel (for the meters). */
export function floatLevel(block: Float32Array | null): number {
  if (!block || block.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
  return Math.min(1, Math.sqrt(sum / block.length) * 5);
}

/**
 * The mic in a call: echo cancellation on, so what the speakers play (the other side, when the
 * user has no headphones) is taken out of the mic again; the call tab gives us that side cleanly.
 */
export const CALL_MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};

/**
 * getDisplayMedia options: Chrome requires video; the picker opens on the "Chrome-flik" pane,
 * leaves out this tab, and ticks "Dela flikljud" by default where Chrome allows it. Local
 * playback stays on, so the user still hears the call.
 */
export const DISPLAY_OPTIONS = {
  video: { displaySurface: "browser" },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
  preferCurrentTab: false,
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
  systemAudio: "include",
} as DisplayMediaStreamOptions;
