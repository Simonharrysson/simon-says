/**
 * A local stand-in for ElevenLabs realtime Scribe (until real credits return 2026-11-28).
 * Speaks the plan's PROVISIONAL event model (docs/learnings.md "Verify on 11-28"):
 *
 *   session_started → partial_transcript (about every second of audio) →
 *   committed_transcript {segment_index, text} → committed_transcript_with_timestamps
 *   (words, no speaker) → diarized_transcript {segment_index, words[].speaker_id} (~200 ms later)
 *   speakers_merged {from_speaker_id, to_speaker_id} once, after the 6th segment
 *   session_time_limit_exceeded + close, after --session-limit seconds (off by default)
 *
 * It ignores what is said: every `--segment` seconds of received audio (or on `commit: true`)
 * it commits the next line of a scripted Swedish/English meeting. It checks the URL settings
 * and that the audio is 16 kHz 16-bit PCM in base64.
 *
 *   npm run fake-el -- [--port 8787] [--segment 4] [--session-limit 0]
 *   ELEVENLABS_WS_URL=ws://localhost:8787/v1/speech-to-text/realtime npm run dev
 *
 * Simulate a network drop: `curl localhost:8787/drop` (closes every socket without a close frame).
 * Simulate a fatal service error: `curl 'localhost:8787/fatal?type=quota_exceeded'` (also
 * auth_error, unaccepted_terms): every open session gets that error message, then closes.
 */
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeOptions {
  port?: number;
  /** Seconds of audio per committed segment. */
  segmentSeconds?: number;
  /** Close each session after this many seconds of wall time (0 = never). */
  sessionLimitSeconds?: number;
  /** Emit one speakers_merged after this many segments in a session (0 = never). */
  mergeAfter?: number;
  log?: (line: string) => void;
}

export interface FakeServer {
  /** ws://127.0.0.1:<port>/v1/speech-to-text/realtime */
  url: string;
  port: number;
  /** Sessions opened so far. */
  sessions: () => number;
  /** Drop every open socket without a close handshake (like Wi-Fi going away). */
  dropAll: () => void;
  /** Send a fatal error message (e.g. quota_exceeded) on every open socket, then close it. */
  fatal: (type?: string) => void;
  close: () => Promise<void>;
}

const PATH = "/v1/speech-to-text/realtime";
const RATE = 16_000;

/** A fictional board meeting. One entry = one segment; several speakers = several runs. */
const SCRIPT: [speaker: string, text: string][][] = [
  [["speaker_0", "Hej allihop och välkomna till styrelsemötet."]],
  [["speaker_1", "Tack. Ska vi börja med budgeten?"], ["speaker_0", "Ja, gärna."]],
  [["speaker_2", "Vi har åtta tusen kronor kvar till hackathonet i februari."]],
  [["speaker_3", "I think we should book the venue this week."]],
  [["speaker_1", "Bra, då bestämmer vi att hackathonet blir fjortonde februari."]],
  [["speaker_3", "Okej."], ["speaker_2", "Jag kan maila Kårallen om lokalen i morgon."]],
  [["speaker_0", "Perfekt. Nästa punkt är rekryteringen."]],
  [["speaker_1", "Vi behöver två nya i eventgruppen innan jul."]],
  [["speaker_2", "Let's post it in the Discord and on Instagram."]],
  [["speaker_0", "Då gör vi så. Något mer innan vi avslutar?"], ["speaker_1", "Nej, det var allt."]],
];

export async function startFakeElevenLabs(opts: FakeOptions = {}): Promise<FakeServer> {
  const segmentSeconds = opts.segmentSeconds ?? 4;
  const sessionLimit = opts.sessionLimitSeconds ?? 0;
  const mergeAfter = opts.mergeAfter ?? 6;
  const log = opts.log ?? ((line: string) => console.log(line));
  let sessions = 0;
  let line = 0; // continues across sessions, like a meeting would
  const sockets = new Set<WebSocket>();

  const fatal = (type = "quota_exceeded") => {
    const n = sockets.size;
    for (const s of sockets) {
      if (s.readyState === s.OPEN) s.send(JSON.stringify({ message_type: type, error: `fake ${type}` }));
      s.close(1008, type);
    }
    log(`[fake-el] sent ${type} to ${n} socket(s)`);
    return n;
  };

  const http: Server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.pathname === "/fatal") {
      const type = reqUrl.searchParams.get("type") ?? "quota_exceeded";
      if (!/^[a-z_]{1,40}$/.test(type)) {
        res.statusCode = 400;
        res.end("type must be a message_type like quota_exceeded\n");
        return;
      }
      res.end(`sent ${type} to ${fatal(type)}\n`);
      return;
    }
    if (req.url === "/drop") {
      const n = sockets.size;
      for (const s of sockets) s.terminate();
      res.end(`dropped ${n}\n`);
      log(`[fake-el] dropped ${n} socket(s)`);
      return;
    }
    res.end(`fake ElevenLabs: ${sockets.size} open, ${sessions} sessions so far\n`);
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "ws://localhost");
    if (url.pathname !== PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSession(ws, url));
  });

  function onSession(ws: WebSocket, url: URL) {
    const id = ++sessions;
    sockets.add(ws);
    const p = url.searchParams;
    const shown = new URL(url);
    shown.searchParams.delete("token");
    log(`[fake-el] session ${id} opened: ${shown.pathname}${shown.search}`);
    const send = (msg: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const problem = !p.get("token")
      ? ["auth_error", "token query param missing"]
      : p.get("model_id") !== "scribe_v3_live"
        ? ["input_error", `model_id must be scribe_v3_live, got ${p.get("model_id")}`]
        : p.get("audio_format") !== "pcm_16000"
          ? ["input_error", `audio_format must be pcm_16000, got ${p.get("audio_format")}`]
          : null;
    if (problem) {
      send({ message_type: problem[0], error: problem[1] });
      ws.close(1008, problem[0]);
      return;
    }
    send({
      message_type: "session_started",
      session_id: `fake_${id}`,
      config: Object.fromEntries([...p].filter(([k]) => k !== "token")),
    });

    let samples = 0; // session-relative audio clock
    let segStart = 0;
    let segIndex = 0;
    let lastPartialAt = 0;
    let chunks = 0;
    const timers: NodeJS.Timeout[] = [];
    if (sessionLimit > 0) {
      timers.push(
        setTimeout(() => {
          send({ message_type: "session_time_limit_exceeded", error: "Maximum session duration reached." });
          ws.close(1000, "session_time_limit_exceeded");
        }, sessionLimit * 1000),
      );
    }

    const commit = () => {
      const entry = SCRIPT[line % SCRIPT.length];
      line++;
      const index = segIndex++;
      const start = segStart / RATE;
      const end = samples / RATE;
      segStart = samples;
      lastPartialAt = samples;
      const flat = entry.flatMap(([speaker, text]) => text.split(" ").map((w) => ({ speaker, w })));
      const step = (end - start) / Math.max(1, flat.length);
      const words: Record<string, unknown>[] = [];
      flat.forEach((x, i) => {
        if (i > 0) words.push({ text: " ", start: start + i * step, end: start + i * step, type: "spacing" });
        words.push({ text: x.w, start: +(start + i * step).toFixed(3), end: +(start + (i + 0.9) * step).toFixed(3), type: "word", speaker_id: x.speaker });
      });
      const text = entry.map(([, t]) => t).join(" ");
      const lang = /\b(the|we|it|let's)\b/i.test(text) ? "en" : "sv";
      send({ message_type: "committed_transcript", segment_index: index, text });
      send({
        message_type: "committed_transcript_with_timestamps",
        segment_index: index,
        text,
        language_code: lang,
        words: words.map(({ speaker_id: _s, ...w }) => w),
      });
      timers.push(
        setTimeout(() => {
          send({ message_type: "diarized_transcript", segment_index: index, language_code: lang, words });
          if (mergeAfter > 0 && segIndex === mergeAfter) {
            send({ message_type: "speakers_merged", from_speaker_id: "speaker_3", to_speaker_id: "speaker_1" });
          }
        }, 200),
      );
    };

    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data));
      } catch {
        send({ message_type: "input_error", error: "message is not JSON" });
        return;
      }
      if (msg.message_type !== "input_audio_chunk") {
        send({ message_type: "input_error", error: `unknown message_type ${String(msg.message_type)}` });
        return;
      }
      if (msg.sample_rate !== undefined && msg.sample_rate !== RATE) {
        send({ message_type: "input_error", error: `sample_rate must be ${RATE}` });
        return;
      }
      const bytes = Buffer.from(String(msg.audio_base_64 ?? ""), "base64");
      if (bytes.length === 0 || bytes.length % 2 !== 0) {
        send({ message_type: "input_error", error: "audio must be non-empty 16-bit PCM" });
        return;
      }
      chunks++;
      samples += bytes.length / 2;
      const inSegment = samples - segStart;
      if (msg.commit === true) {
        if (inSegment < RATE * 0.3) send({ message_type: "commit_throttled", error: "not enough audio since the last commit" });
        else commit();
        return;
      }
      if (inSegment >= segmentSeconds * RATE) {
        commit();
        return;
      }
      if (samples - lastPartialAt >= RATE) {
        lastPartialAt = samples;
        const entry = SCRIPT[line % SCRIPT.length];
        const all = entry.map(([, t]) => t).join(" ").split(" ");
        const shownWords = Math.max(1, Math.round((all.length * inSegment) / (segmentSeconds * RATE)));
        send({ message_type: "partial_transcript", text: all.slice(0, shownWords).join(" ") });
      }
    });
    ws.on("close", (code) => {
      sockets.delete(ws);
      for (const t of timers) clearTimeout(t);
      log(`[fake-el] session ${id} closed (${code}) after ${(samples / RATE).toFixed(1)} s of audio in ${chunks} chunks`);
    });
  }

  await new Promise<void>((resolve) => http.listen(opts.port ?? 8787, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}${PATH}`,
    port,
    sessions: () => sessions,
    dropAll: () => {
      for (const s of sockets) s.terminate();
    },
    fatal: (type?: string) => void fatal(type),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.terminate();
        wss.close();
        http.close(() => resolve());
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const num = (name: string, dflt: number) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? Number(args[i + 1]) : dflt;
  };
  const server = await startFakeElevenLabs({
    port: num("port", 8787),
    segmentSeconds: num("segment", 4),
    sessionLimitSeconds: num("session-limit", 0),
  });
  console.log(`fake ElevenLabs listening on ${server.url}`);
  console.log(`run the app with: ELEVENLABS_WS_URL=${server.url.replace("127.0.0.1", "localhost")} npm run dev`);
  console.log(`simulate a network drop: curl localhost:${server.port}/drop`);
  console.log(`simulate a fatal error: curl 'localhost:${server.port}/fatal?type=quota_exceeded'`);
}
