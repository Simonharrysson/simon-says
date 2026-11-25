// Mic audio → what ElevenLabs takes (`audio_format=pcm_16000`: 16 kHz mono, 16-bit signed
// little-endian PCM, base64). Pure; runs in the browser and in tests.

export const TARGET_RATE = 16_000;

/**
 * Resample float samples (-1…1) at `inRate` to 16 kHz 16-bit PCM. Downsampling averages each
 * output sample's input window (a box filter: cheap anti-aliasing, flat enough for speech);
 * upsampling interpolates linearly. Output length = round(n · 16000 / inRate), so a 100 ms
 * block (inRate / 10 samples) always becomes exactly 1600 samples at 48 kHz and 44.1 kHz.
 * Blocks are resampled independently (no state), which is why callers feed 100 ms blocks.
 */
export function resampleTo16kPcm16(input: Float32Array, inRate: number): Int16Array {
  if (!(inRate > 0)) throw new Error(`resampleTo16kPcm16: bad sample rate ${inRate}`);
  const n = input.length;
  const outLen = Math.round((n * TARGET_RATE) / inRate);
  const out = new Int16Array(outLen);
  const ratio = inRate / TARGET_RATE;
  for (let i = 0; i < outLen; i++) {
    let v: number;
    if (ratio > 1) {
      const from = Math.floor(i * ratio);
      const to = Math.min(n, Math.max(from + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = from; j < to; j++) sum += input[j];
      v = sum / (to - from);
    } else {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const a = input[Math.min(j, n - 1)] ?? 0;
      const b = input[Math.min(j + 1, n - 1)] ?? a;
      v = a + (b - a) * (pos - j);
    }
    out[i] = toInt16(v);
  }
  return out;
}

function toInt16(v: number): number {
  if (v >= 1) return 32767;
  if (v <= -1) return -32768;
  return v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
}

/** Little-endian bytes of the PCM as base64 (the `audio_base_64` field). */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
  let bin = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  return btoa(bin);
}

/** Inverse of pcm16ToBase64 (fake server, tests). */
export function base64ToPcm16(b64: string): Int16Array {
  const bin = atob(b64);
  const view = new DataView(new ArrayBuffer(bin.length - (bin.length % 2)));
  for (let i = 0; i < view.byteLength; i++) view.setUint8(i, bin.charCodeAt(i));
  const out = new Int16Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Loudness 0–1 for the mic meter (RMS, scaled so normal speech at a table reads ~0.2–0.6). */
export function rmsLevel(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2;
  return Math.min(1, Math.sqrt(sum / pcm.length) * 5);
}
