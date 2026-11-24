import "server-only";
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
  const url = new URL(WS_URL);
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
