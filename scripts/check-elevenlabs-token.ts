/**
 * Task 4 early check: a real token mint and a real WebSocket connection with the exact wsUrl
 * the token endpoint returns. Costs a few seconds of Scribe time.
 *
 *   npm run check-elevenlabs-token -- [maxSessionSeconds=60] [audioSeconds=5]
 *
 * Mints via lib/elevenlabs/token (max_session_duration_seconds on the mint), connects to
 * `${realtimeWsUrl()}&token=…`, sends `audioSeconds` of silent 16 kHz PCM16 in 100 ms chunks,
 * and prints every message type. Exits non-zero on a mint error, a socket error, a close
 * before `session_started`, or any message whose type looks like an error (invalid_request …).
 *
 * Env: ~/simon-says-private/.env (override with SIMON_SAYS_ENV); only ELEVENLABS_API_KEY and
 * optionally ELEVENLABS_COMMIT_STRATEGY are used. Never prints the key or the token.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function loadEnvFile(path: string): void {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadEnvFile(process.env.SIMON_SAYS_ENV ?? join(homedir(), "simon-says-private", ".env"));
// Required by lib/env but unused here.
const unused: Record<string, string> = {
  SUPABASE_URL: "https://unused.supabase.co",
  SUPABASE_ANON_KEY: "unused",
  SUPABASE_SERVICE_ROLE_KEY: "unused",
  GOOGLE_CLIENT_ID: "unused",
  GOOGLE_CLIENT_SECRET: "unused",
  TOKEN_ENC_KEY: Buffer.alloc(32).toString("base64"),
  ANTHROPIC_API_KEY: "unused",
  ALARM_EMAIL: "unused@example.com",
  CRON_SECRET: "unused",
  APP_URL: "http://localhost:3000",
};
for (const [k, v] of Object.entries(unused)) process.env[k] ??= v;

const { mintToken, realtimeWsUrl } = await import("@/lib/elevenlabs/token");

const maxSessionSeconds = Number(process.argv[2] ?? 60);
const audioSeconds = Number(process.argv[3] ?? 5);
const SAMPLE_RATE = 16_000;
const CHUNK_MS = 100;
const ERROR_TYPE = /error|invalid|exceeded|limited|overflow|exhausted|throttled|insufficient|terms/i;

const wsUrl = realtimeWsUrl();
console.log(`wsUrl (no token): ${wsUrl}`);
console.log(`minting with max_session_duration_seconds=${maxSessionSeconds} …`);
const token = await mintToken(maxSessionSeconds);
console.log("mint ok");

const silence = Buffer.alloc((SAMPLE_RATE * CHUNK_MS) / 1000 * 2).toString("base64");
const ws = new WebSocket(`${wsUrl}&token=${encodeURIComponent(token)}`);
let started = false;
let failed = false;

const done = new Promise<void>((resolve) => {
  ws.onmessage = (ev) => {
    let msg: { message_type?: string; error?: string };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      console.log(`non-JSON message (${String(ev.data).length} chars)`);
      return;
    }
    const type = msg.message_type ?? "(no message_type)";
    console.log(`← ${type}${msg.error ? `: ${msg.error}` : ""}`);
    if (type === "session_started") started = true;
    if (ERROR_TYPE.test(type)) failed = true;
  };
  ws.onerror = () => {
    console.error("socket error");
    failed = true;
  };
  ws.onclose = (ev) => {
    console.log(`closed ${ev.code} ${ev.reason}`);
    resolve();
  };
});

await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  setTimeout(() => reject(new Error("socket did not open within 10 s")), 10_000);
});
console.log("socket open; sending silence …");
for (let sent = 0; sent < (audioSeconds * 1000) / CHUNK_MS && ws.readyState === WebSocket.OPEN; sent++) {
  ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: silence, commit: false, sample_rate: SAMPLE_RATE }));
  await new Promise((r) => setTimeout(r, CHUNK_MS));
}
await new Promise((r) => setTimeout(r, 2000));
if (ws.readyState === WebSocket.OPEN) ws.close(1000, "check done");
await done;

if (!started) failed = true;
console.log(failed ? "FAIL (see messages above)" : "OK: session started, no error messages");
process.exit(failed ? 1 : 0);
