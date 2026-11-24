// Loads ELEVENLABS_API_KEY from the process env, or from the dotenv file named by
// SPIKE_ENV_FILE. Never prints the key.
import { readFileSync } from 'node:fs';

export function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  const file = process.env.SPIKE_ENV_FILE;
  if (file) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*ELEVENLABS_API_KEY\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && m[1]) return m[1];
    }
  }
  throw new Error('ELEVENLABS_API_KEY not set (env var or SPIKE_ENV_FILE)');
}

// POST /v1/single-use-token/realtime_scribe. maxSessionSeconds goes on the mint:
// it is NOT a WebSocket query param.
export async function mintToken(maxSessionSeconds) {
  const u = new URL('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
  if (maxSessionSeconds) u.searchParams.set('max_session_duration_seconds', String(maxSessionSeconds));
  const r = await fetch(u, { method: 'POST', headers: { 'xi-api-key': apiKey() } });
  if (!r.ok) throw new Error(`token mint failed: ${r.status} ${await r.text()}`);
  return (await r.json()).token;
}
