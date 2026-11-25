import { describe, expect, it } from "vitest";
import { base64ToPcm16, pcm16ToBase64, resampleTo16kPcm16, rmsLevel } from "./resample";

function sine(rate: number, seconds: number, freq: number, amp: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

const peak = (a: Int16Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe("resampleTo16kPcm16", () => {
  it("48 kHz 1 s sine → 16 000 samples, amplitude within 1 %", () => {
    const out = resampleTo16kPcm16(sine(48_000, 1, 440, 0.5), 48_000);
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(16_000);
    expect(Math.abs(peak(out) / 32767 - 0.5) / 0.5).toBeLessThan(0.01);
  });

  it("44.1 kHz: a 100 ms block (4410) → exactly 1600 samples, amplitude within 1 %", () => {
    const out = resampleTo16kPcm16(sine(44_100, 0.1, 440, 0.5), 44_100);
    expect(out.length).toBe(1600);
    expect(Math.abs(peak(out) / 32767 - 0.5) / 0.5).toBeLessThan(0.01);
  });

  it("16 kHz passes through; 8 kHz upsamples", () => {
    const same = sine(16_000, 0.1, 440, 0.5);
    const out = resampleTo16kPcm16(same, 16_000);
    expect(out.length).toBe(1600);
    expect(out[10]).toBe(Math.round(same[10] * 32767));
    expect(resampleTo16kPcm16(sine(8_000, 0.1, 200, 0.5), 8_000).length).toBe(1600);
  });

  it("clips out-of-range input instead of wrapping", () => {
    const out = resampleTo16kPcm16(new Float32Array([2, -2, 2, -2]), 16_000);
    expect(Array.from(out)).toEqual([32767, -32768, 32767, -32768]);
  });
});

describe("pcm16 base64", () => {
  it("round-trips little-endian 16-bit PCM", () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768, 1234]);
    const b64 = pcm16ToBase64(pcm);
    expect(Buffer.from(b64, "base64")).toEqual(Buffer.from([0, 0, 1, 0, 255, 255, 255, 127, 0, 128, 210, 4]));
    expect(Array.from(base64ToPcm16(b64))).toEqual(Array.from(pcm));
  });
});

describe("rmsLevel", () => {
  it("is 0 for silence and grows with loudness, capped at 1", () => {
    expect(rmsLevel(new Int16Array(100))).toBe(0);
    const loud = rmsLevel(new Int16Array(100).fill(20_000));
    const quiet = rmsLevel(new Int16Array(100).fill(500));
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThanOrEqual(1);
  });
});
