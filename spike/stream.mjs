// Streams a raw 16 kHz mono s16le file to ElevenLabs realtime STT at real-time
// pacing (100 ms chunks every 100 ms) and logs every server message as JSON lines.
//
// node spike/stream.mjs --pcm in.pcm --out events.jsonl [--commit vad|manual|turn_prediction]
//   [--manual-every 25] [--infer-names] [--keyterm X ...] [--max-session 14400]
//   [--reconnect-at 300] [--limit-sec 60] [--speed 1] [--param k=v ...]
import { readFileSync, openSync, writeSync, appendFileSync } from 'node:fs';
import { mintToken } from './key.mjs';

const args = process.argv.slice(2);
const opt = { keyterm: [], param: [] };
for (let i = 0; i < args.length; i++) {
  const k = args[i].replace(/^--/, '');
  const next = args[i + 1];
  if (k === 'infer-names' || k === 'dry') { opt[k === 'dry' ? 'dry' : 'inferNames'] = true; continue; }
  if (Array.isArray(opt[k])) opt[k].push(next); else opt[k] = next;
  i++;
}
if (!opt.pcm || !opt.out) { console.error('need --pcm and --out'); process.exit(2); }

const SR = 16000, CHUNK_MS = 100, CHUNK_BYTES = SR * 2 * CHUNK_MS / 1000;
let pcm = readFileSync(opt.pcm);
if (opt['limit-sec']) pcm = pcm.subarray(0, Number(opt['limit-sec']) * SR * 2);
const totalChunks = Math.ceil(pcm.length / CHUNK_BYTES);
const speed = Number(opt.speed || 1);
const manualEvery = opt['manual-every'] ? Number(opt['manual-every']) : 0;
const reconnectAt = opt['reconnect-at'] ? Number(opt['reconnect-at']) : 0;
const out = openSync(opt.out, 'a');
const t0 = Date.now();

function log(obj) { writeSync(out, JSON.stringify(obj) + '\n'); } // sync write = flushed per line

function wsUrl(token) {
  const u = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  const p = u.searchParams;
  p.set('model_id', 'scribe_v3_live');
  p.set('audio_format', 'pcm_16000');
  p.set('diarize', 'true');
  p.set('multilang_mode', 'true');
  p.set('include_timestamps', 'true');
  p.set('commit_strategy', opt.commit || 'vad');
  if (opt.inferNames) p.set('infer_speaker_names', 'true');
  for (const kt of opt.keyterm) p.append('keyterms', kt);
  for (const kv of opt.param) { const [k, v] = kv.split('='); p.set(k, v); }
  p.set('token', token);
  return u;
}

let sent = 0;        // chunks sent overall
let conn = 0;
let lastSentWall = 0;

async function connect() {
  conn++;
  if (opt.dry) { log({ k: 'meta', conn, t: Date.now() - t0, dry: true, audio_offset_s: sent / 10 }); return { readyState: WebSocket.OPEN, send() {}, close() {} }; }
  const token = await mintToken(Number(opt['max-session'] || 0) || undefined);
  const url = wsUrl(token);
  const shown = new URL(url); shown.searchParams.delete('token');
  log({ k: 'meta', conn, t: Date.now() - t0, url_without_token: shown.toString(), audio_offset_s: sent * CHUNK_MS / 1000 });
  const ws = new WebSocket(url);
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { msg = { raw: String(ev.data) }; }
    log({ k: 'ev', conn, t: Date.now() - t0, sent_s: sent * CHUNK_MS / 1000, msg });
    if (msg.message_type && /error|exceeded|limited|overflow|exhausted|throttled|terms|insufficient/.test(msg.message_type))
      console.error(`[conn ${conn}] ${msg.message_type}: ${msg.error || ''}`);
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => { log({ k: 'ws_error', conn, t: Date.now() - t0, err: String(e.message || e.type) }); reject(e); };
    ws.onclose = (e) => {
      log({ k: 'close', conn, t: Date.now() - t0, code: e.code, reason: e.reason, sent_s: sent * CHUNK_MS / 1000 });
      console.error(`[conn ${conn}] closed ${e.code} ${e.reason} at audio ${sent / 10}s`);
    };
  });
}

function send(ws, commit) {
  const off = sent * CHUNK_BYTES;
  const chunk = pcm.subarray(off, off + CHUNK_BYTES);
  ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: chunk.toString('base64'), commit, sample_rate: SR }));
  sent++;
}

let ws = await connect();
let didReconnect = false;
const start = Date.now();
while (sent < totalChunks) {
  if (ws.readyState !== WebSocket.OPEN) { console.error('socket not open; stopping'); await new Promise(r => setTimeout(r, 1500)); break; } // let onclose log the code
  if (reconnectAt && !didReconnect && sent * CHUNK_MS / 1000 >= reconnectAt) {
    didReconnect = true;
    log({ k: 'forced_close', conn, t: Date.now() - t0, sent_s: sent / 10 });
    ws.close(1000, 'spike forced reconnect');
    await new Promise(r => setTimeout(r, 1000));
    ws = await connect();
  }
  const commit = manualEvery > 0 && (sent + 1) % (manualEvery * 10) === 0;
  send(ws, commit);
  if (commit) log({ k: 'manual_commit', conn, t: Date.now() - t0, sent_s: sent / 10 });
  // drift-corrected real-time pacing
  const due = start + (sent * CHUNK_MS) / speed;
  const wait = due - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  if (sent % 600 === 0) console.error(`[conn ${conn}] audio ${sent / 10}s / ${totalChunks / 10}s`);
}
// Flush the tail: commit whatever is left, then wait for trailing events.
if (ws.readyState === WebSocket.OPEN) {
  const silence = Buffer.alloc(CHUNK_BYTES).toString('base64');
  ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: silence, commit: true, sample_rate: SR }));
  log({ k: 'final_commit', conn, t: Date.now() - t0, sent_s: sent / 10 });
  await new Promise(r => setTimeout(r, 8000));
  ws.close(1000, 'done');
  await new Promise(r => setTimeout(r, 500));
}
const audioHours = sent * CHUNK_MS / 3600000;
if (process.env.SPIKE_TALLY) appendFileSync(process.env.SPIKE_TALLY, `${new Date().toISOString()}\t${opt.out}\t${audioHours.toFixed(4)}\n`);
console.error(`done: ${sent / 10}s audio sent (${audioHours.toFixed(3)} h)`);
process.exit(0);
