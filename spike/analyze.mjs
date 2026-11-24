// Summarises an events .jsonl written by stream.mjs. Prints stats only (no text)
// unless --runs <file> is given, which writes speaker runs WITH text to that file
// (keep it outside the repo for real recordings).
import { readFileSync, writeFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
const runsOut = rest[rest.indexOf('--runs') + 1] && rest.includes('--runs') ? rest[rest.indexOf('--runs') + 1] : null;
const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(2); };
const stats = a => ({ n: a.length, p50: pct(a, 50), p90: pct(a, 90), max: pct(a, 100) });

const counts = {}, configs = [], closes = [], merges = [], names = [], errors = [];
const connOffset = {};               // audio offset (s) at which each connection started
const committed = {}, diarized = {}, withTs = {};
const lastPartialWords = {};          // conn -> words of latest partial
const partialAtCommit = {};           // key -> partial words just before commit
const keyOf = (c, i) => `${c}:${i}`;
let lastSegIdx = {};

for (const l of lines) {
  if (l.k === 'meta') connOffset[l.conn] = l.audio_offset_s;
  if (l.k === 'close') closes.push({ conn: l.conn, code: l.code, reason: l.reason, sent_s: l.sent_s });
  if (l.k !== 'ev') continue;
  const m = l.msg, type = m.message_type || 'unknown';
  counts[type] = (counts[type] || 0) + 1;
  if (type === 'session_started') configs.push({ conn: l.conn, session_id: m.session_id, config: m.config });
  else if (type === 'partial_transcript') { if (m.words) lastPartialWords[l.conn] = m.words; }
  else if (type === 'committed_transcript') {
    const k = keyOf(l.conn, m.segment_index ?? `n${Object.keys(committed).length}`);
    committed[k] = { t: l.t, sent_s: l.sent_s, chars: (m.text || '').length, seg: m.segment_index };
    lastSegIdx[l.conn] = m.segment_index;
    partialAtCommit[k] = lastPartialWords[l.conn]; lastPartialWords[l.conn] = null;
  }
  else if (type === 'committed_transcript_with_timestamps') {
    const k = keyOf(l.conn, m.segment_index ?? lastSegIdx[l.conn]);
    withTs[k] = { t: l.t, sent_s: l.sent_s, words: m.words || [], lang: m.language_code };
  }
  else if (type === 'diarized_transcript') diarized[keyOf(l.conn, m.segment_index)] = { t: l.t, sent_s: l.sent_s, words: m.words || [], seg: m.segment_index };
  else if (type === 'speakers_merged') merges.push({ conn: l.conn, t: l.t, from: m.from_speaker_id, to: m.to_speaker_id });
  else if (type === 'speaker_names') names.push({ conn: l.conn, t: l.t, n: Object.keys(m.speaker_names || {}).length });
  else if (!/partial|committed|diarized/.test(type)) errors.push({ conn: l.conn, t: l.t, type, error: m.error || m.warning });
}

// segment lengths + latency (audio sent at receipt minus end time of last word)
const segLen = [], lagCommit = [], lagDiar = [], diarAfterCommit = [], langs = {};
for (const [k, w] of Object.entries(withTs)) {
  const words = w.words.filter(x => x.type === 'word' && x.end != null);
  if (!words.length) continue;
  segLen.push(words.at(-1).end - words[0].start);
  langs[w.lang] = (langs[w.lang] || 0) + 1;
  const conn = +k.split(':')[0];
  const endAbs = (connOffset[conn] || 0) + words.at(-1).end;
  if (committed[k]) lagCommit.push(committed[k].sent_s - endAbs);
  if (diarized[k]) lagDiar.push(diarized[k].sent_s - endAbs);
}
for (const [k, d] of Object.entries(diarized)) if (committed[k]) diarAfterCommit.push((d.t - committed[k].t) / 1000);

// speaker resolution + partial-vs-diarized label stability
let words = 0, nullSpk = 0, cmp = 0, same = 0;
for (const [k, d] of Object.entries(diarized)) {
  const dw = d.words.filter(x => x.type === 'word');
  words += dw.length; nullSpk += dw.filter(x => x.speaker_id == null).length;
  const pw = (partialAtCommit[k] || []).filter(x => x.type === 'word');
  for (let i = 0; i < Math.min(pw.length, dw.length); i++) {
    if (pw[i].text !== dw[i].text || pw[i].speaker_id == null) continue;
    cmp++; if (pw[i].speaker_id === dw[i].speaker_id) same++;
  }
}

// speaker runs (merges applied in order received, per connection)
const runs = [];
const resolve = (conn, id) => { let x = id; for (const m of merges) if (m.conn === conn && m.from === x) x = m.to; return x; };
for (const d of Object.values(diarized).sort((a, b) => a.t - b.t)) {
  const conn = +Object.keys(diarized).find(k => diarized[k] === d).split(':')[0];
  let run = null;
  for (const w of d.words) {
    if (w.type === 'spacing') { if (run) run.text += w.text; continue; }
    const spk = w.speaker_id == null ? null : resolve(conn, w.speaker_id);
    if (!run || run.speaker !== spk) {
      if (run) runs.push(run);
      run = { conn, seg: d.seg, speaker: spk, start: w.start != null ? +((connOffset[conn] || 0) + w.start).toFixed(2) : null, text: '' };
    }
    run.text += w.text; run.end = w.end != null ? +((connOffset[conn] || 0) + w.end).toFixed(2) : run.end;
  }
  if (run) runs.push(run);
}
const runsPerSeg = {};
for (const r of runs) runsPerSeg[`${r.conn}:${r.seg}`] = (runsPerSeg[`${r.conn}:${r.seg}`] || 0) + 1;
const spkTime = {};
for (const r of runs) spkTime[`${r.conn}/${r.speaker}`] = +(((spkTime[`${r.conn}/${r.speaker}`] || 0) + ((r.end ?? 0) - (r.start ?? 0)))).toFixed(1);

console.log(JSON.stringify({
  file, counts, configs, closes, errors: errors.slice(0, 20), merges, speaker_names_events: names.length,
  segments: Object.keys(committed).length, diarized: Object.keys(diarized).length,
  segment_len_s: stats(segLen), languages: langs,
  latency_commit_s: stats(lagCommit), latency_diarized_s: stats(lagDiar), diarized_after_commit_s: stats(diarAfterCommit),
  words, null_speaker_words: nullSpk, partial_vs_diarized_label: { compared: cmp, same },
  runs: runs.length, segments_with_multiple_runs: Object.values(runsPerSeg).filter(n => n > 1).length,
  speaker_seconds: spkTime,
}, null, 1));
if (runsOut) writeFileSync(runsOut, runs.map((r, i) => `${i}\t${r.start}\t${r.end}\tc${r.conn}/${r.speaker}\t${r.text.trim()}`).join('\n') + '\n');
