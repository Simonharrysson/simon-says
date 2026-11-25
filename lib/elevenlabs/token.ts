import "server-only";
import { randomUUID } from "node:crypto";
import { getEnv } from "@/lib/env";

const MINT_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
/** A hung mint must fail (and release the claimed session) well inside the function limit. */
const MINT_TIMEOUT_MS = 10_000;

/**
 * Mint a single-use realtime Scribe token. `maxSessionSeconds` closes the session it opens
 * (the remaining allowed meeting time); it is a mint parameter, not a WebSocket one. The
 * token itself only has to be used within 15 minutes. Never logs the key or the token.
 */
export async function mintToken(maxSessionSeconds: number): Promise<string> {
  if (!Number.isInteger(maxSessionSeconds) || maxSessionSeconds <= 0) {
    throw new Error(`mintToken: maxSessionSeconds must be a positive integer, got ${maxSessionSeconds}`);
  }
  // Dev/test fake server: no ElevenLabs call, no credits. The fake accepts any token.
  if (devWsOverride()) return `fake-${randomUUID()}`;
  const url = new URL(MINT_URL);
  url.searchParams.set("max_session_duration_seconds", String(maxSessionSeconds));
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": getEnv().ELEVENLABS_API_KEY },
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`mintToken: ElevenLabs ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { token?: unknown };
  if (typeof json.token !== "string" || json.token === "") throw new Error("mintToken: no token in response");
  return json.token;
}

/**
 * The realtime WebSocket URL with every session setting, WITHOUT the token: the client
 * connects to `${wsUrl}&token=${encodeURIComponent(token)}`.
 */
export function realtimeWsUrl(): string {
  const url = new URL(devWsOverride() ?? WS_URL);
  const p = url.searchParams;
  p.set("model_id", "scribe_v3_live");
  p.set("diarize", "true");
  p.set("multilang_mode", "true");
  p.set("include_timestamps", "true");
  p.set("include_language_detection", "true");
  p.set("audio_format", "pcm_16000");
  p.set("commit_strategy", getEnv().ELEVENLABS_COMMIT_STRATEGY);
  return url.toString();
}

let warned = false;

/**
 * `ELEVENLABS_WS_URL` points the browser at a local fake ElevenLabs server
 * (`npm run fake-el`) and skips the real mint. Dev and tests only: ignored (with a warning)
 * when NODE_ENV or VERCEL_ENV is production, so a stray value can never reach real meetings.
 */
export function devWsOverride(source: Record<string, string | undefined> = process.env): string | null {
  const url = source.ELEVENLABS_WS_URL;
  if (!url) return null;
  if (source.NODE_ENV === "production" || source.VERCEL_ENV === "production") {
    if (!warned) console.warn("ELEVENLABS_WS_URL is set but ignored in production");
    warned = true;
    return null;
  }
  if (!/^wss?:\/\//.test(url)) throw new Error("ELEVENLABS_WS_URL must be a ws:// or wss:// URL");
  return url;
}
