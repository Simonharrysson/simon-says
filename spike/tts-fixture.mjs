// Builds fixtures/elevenlabs/scripted.wav from fixture-script.json with 4 ElevenLabs
// TTS voices, mixed digitally with light pink "room" noise (no speaker playback).
// Also writes scripted.truth.json: per-line speaker + start/end in the final wav.
// node spike/tts-fixture.mjs <workdir>
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { apiKey } from './key.mjs';

const work = process.argv[2]; mkdirSync(work, { recursive: true });
const root = new URL('../', import.meta.url).pathname;
const script = JSON.parse(readFileSync(new URL('./fixture-script.json', import.meta.url)));
const H = { 'xi-api-key': apiKey() };
const get = async p => { const r = await fetch('https://api.elevenlabs.io' + p, { headers: H }); if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`); return r.json(); };

const models = await get('/v1/models');
const tts = models.filter(m => m.can_do_text_to_speech && (m.languages || []).some(l => /^sv|swe/i.test(l.language_id)));
const model = (tts.find(m => m.model_id === 'eleven_multilingual_v2') || tts[0]).model_id;
const { voices } = await get('/v1/voices');
const premade = voices.filter(v => v.category === 'premade');
const pick = (g, skip = []) => premade.find(v => (v.labels?.gender === g) && !skip.includes(v.voice_id));
const f1 = pick('female'), f2 = pick('female', [f1.voice_id]), m1 = pick('male'), m2 = pick('male', [m1.voice_id]);
const voiceOf = { A: f1, B: m1, C: f2, D: m2 };
console.error('model', model, 'voices', Object.fromEntries(Object.entries(voiceOf).map(([k, v]) => [k, v.name])));

const SR = 16000; const parts = []; const truth = []; let t = 1.0; // 1 s lead-in
parts.push(Buffer.alloc(SR * 2 * 1));
for (const [i, [spk, lang, text]] of script.lines.entries()) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceOf[spk].voice_id}?output_format=pcm_16000`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: model, ...(model.includes('multilingual') || model.includes('v3') ? { language_code: lang === 'sv' ? 'sv' : 'en' } : {}) }) });
  if (!r.ok) throw new Error(`tts line ${i}: ${r.status} ${await r.text()}`);
  const pcm = Buffer.from(await r.arrayBuffer());
  const dur = pcm.length / 2 / SR;
  truth.push({ line: i, speaker: spk, lang, start: +t.toFixed(2), end: +(t + dur).toFixed(2), text });
  parts.push(pcm); t += dur;
  const gap = i % 5 === 3 ? 0.15 : 0.45 + (i % 3) * 0.25; // a few near-overlaps / quick turns
  parts.push(Buffer.alloc(Math.round(SR * gap) * 2)); t += gap;
}
writeFileSync(`${work}/voices.pcm`, Buffer.concat(parts));
const out = `${root}fixtures/elevenlabs/scripted.wav`;
execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', `${work}/voices.pcm`,
  '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.02:sample_rate=16000',
  '-filter_complex', '[0:a]aecho=0.8:0.5:30|55:0.25|0.15[v];[v][1:a]amix=inputs=2:duration=first:normalize=0[m]',
  '-map', '[m]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
writeFileSync(`${root}fixtures/elevenlabs/scripted.truth.json`, JSON.stringify({ model, voices: Object.fromEntries(Object.entries(voiceOf).map(([k, v]) => [k, v.name])), lines: truth }, null, 1));
console.error('wrote', out, 'duration', t.toFixed(1), 's');
