import type { IncomingMessage, ServerResponse } from "node:http";
import { GOALS_SYSTEM_PROMPT } from "@/lib/dashboard/goals";
import { ROLES_SYSTEM_PROMPT } from "@/lib/agenda/roles";
import { STADGAR_SYSTEM_PROMPT } from "@/lib/formats/stadgar";
import { DIGEST_SYSTEM_PROMPT } from "@/lib/history/digest";
import { EXTRACT_SYSTEM_PROMPT } from "@/lib/history/extract-prompt";
import { NAMES_SYSTEM_PROMPT } from "@/lib/names/extract";
import { AGENDA_SYSTEM_PROMPT } from "@/lib/notes/agenda-prompt";
import { CHECKIN_SYSTEM_PROMPT } from "@/lib/notes/checkin";
import { SYSTEM_PROMPT } from "@/lib/notes/prompt";
import { PRIVAT_SUMMARY_SYSTEM_PROMPT } from "@/lib/privat/summary";
import { readBody, send } from "./google";
import { SCRIPTED } from "./scripted";

export { SCRIPTED };

// The fake Claude behind the e2e app (ANTHROPIC_BASE_URL): POST /v1/messages, streamed (SSE) like
// the SDK's `beta.messages.stream()` expects. Calls are told apart by their system prompt, as
// test/meeting-sim.ts `scriptedClient` does, and answered with fixed, schema-valid JSON. An
// unknown prompt is a 500 and lands in `problems`: a call nobody scripted never passes quietly.

export type ClaudeKind = "privat-summary" | "notes" | "agenda-notes" | "names" | "checkin" | "stadgar" | "stadgar-both" | "goals" | "extract" | "digest" | "roles";

const KINDS: [string, ClaudeKind][] = [
  [PRIVAT_SUMMARY_SYSTEM_PROMPT, "privat-summary"],
  [AGENDA_SYSTEM_PROMPT, "agenda-notes"],
  [SYSTEM_PROMPT, "notes"],
  [NAMES_SYSTEM_PROMPT, "names"],
  [CHECKIN_SYSTEM_PROMPT, "checkin"],
  [STADGAR_SYSTEM_PROMPT, "stadgar"],
  [GOALS_SYSTEM_PROMPT, "goals"],
  [EXTRACT_SYSTEM_PROMPT, "extract"],
  [DIGEST_SYSTEM_PROMPT, "digest"],
  [ROLES_SYSTEM_PROMPT, "roles"],
];

export interface ClaudeCall {
  at: string;
  kind: ClaudeKind | "unknown";
  /** The user message's text, cut. */
  text: string;
}

type Body = {
  system?: string | { text?: string }[];
  messages?: { content: string | { type: string; text?: string }[] }[];
  stream?: boolean;
};

const systemText = (b: Body) => (typeof b.system === "string" ? b.system : (b.system ?? []).map((s) => s.text ?? "").join(""));
const userText = (b: Body) =>
  (b.messages ?? [])
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("\n")))
    .join("\n");

function answer(kind: ClaudeKind, text: string): unknown {
  switch (kind) {
    case "notes":
      // Once per meeting: later ticks see the items in the notes state and add nothing.
      if (text.includes(SCRIPTED.decision)) return { ops: [] };
      return {
        ops: [
          { op: "add", id: "a", section: "decision", text: SCRIPTED.decision },
          { op: "add", id: "b", section: "action", text: SCRIPTED.action },
          { op: "add", id: "c", section: "now", text: SCRIPTED.now },
        ],
      };
    case "agenda-notes":
      if (text.includes(SCRIPTED.decision)) return { ops: [] };
      return {
        ops: [
          { op: "add", id: "a", kind: "decision", anchor: "notes", text: SCRIPTED.decision },
          { op: "add", id: "b", kind: "task", anchor: "notes", text: SCRIPTED.action },
        ],
      };
    case "names": {
      // By voice: speaker_k is SCRIPTED.names[k]. The fake ElevenLabs merges speaker_3 into speaker_1
      // (one person heard as two voices): speaker_3 gets no name of its own (two labels with one
      // name are rightly asked about, and a second name would conflict with the merge).
      const labels = [...new Set(text.match(/S\d+-speaker_\d+/g) ?? [])];
      // Only names of the förening's known people are "heard": a förening without them keeps its
      // voices unnamed (attendance unsure).
      const known = text.split("<transcript>")[0];
      const nameOf = (label: string) => {
        const name = label.endsWith("speaker_3") ? undefined : SCRIPTED.names[Number(label.split("_").at(-1))];
        return name && known.includes(name) ? name : undefined;
      };
      return { speakers: labels.filter((l) => nameOf(l)).map((speaker) => ({ speaker, name: nameOf(speaker), needs_confirm: false })) };
    }
    case "privat-summary": {
      // The open tasks come in as "[t1] text …": the first is done, the rest still open. A first
      // recording (no open tasks) gets the first task, later ones a new task.
      const keys = [...text.matchAll(/^\[(t\d+)\] /gm)].map((m) => m[1]);
      const p = SCRIPTED.privat;
      return {
        summary: p.summary,
        decisions: keys.length ? [] : [p.decision],
        facts: [],
        tasks: [{ text: keys.length ? p.nextTask : p.firstTask, owner: null, due: null }],
        questions: [p.question],
        people: [],
        topics: ["labb 2"],
        previous: keys.map((id, i) => ({ id, status: i === 0 ? "done" : "open" })),
      };
    }
    case "checkin":
      return { start_at: null, end_at: null };
    case "stadgar":
      return { items: ["Föregående protokoll", "Ekonomisk rapport"] };
    case "stadgar-both":
      return { board: ["Föregående protokoll", "Ekonomisk rapport"], arsmote: ["Val av ordförande", "Verksamhetsberättelse"] };
    case "goals":
      return { goals: SCRIPTED.goals, explanation: "Målen bygger på vad ni har beslutat på era möten." };
    case "extract": {
      const date = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
      return {
        date,
        topics: ["Hackathon"],
        decisions: [{ text: "Hackathonet planeras till februari", topic: "Hackathon" }],
        tasks: [{ text: "Boka lokal till hackathonet", owner: "Anna Berg", done: false, topic: "Hackathon" }],
        reports: [],
        names: ["Anna Berg"],
      };
    }
    case "digest": {
      // Evidence must name meetings of the history (finalizeGoals drops the rest).
      const dates = [...new Set(text.match(/\d{4}-\d{2}-\d{2}/g) ?? [])].sort();
      const last = dates.at(-1) ?? null;
      return {
        goals: [
          {
            title: "Ett hackathon i februari",
            status: "current",
            why: "Det har tagits upp på flera möten.",
            earlier_names: [],
            first_mentioned: dates[0] ?? null,
            last_mentioned: last,
            evidence: dates.slice(-3).map((date) => ({ date, text: "Hackathonet planeras till februari." })),
          },
        ],
        explanation: "Målet bygger på era inlästa protokoll.",
      };
    }
    case "roles": {
      const keys = [...new Set(text.match(/ag-\d+/g) ?? [])];
      return { roles: keys.map((key) => ({ key, role: "topic" })) };
    }
  }
}

export class ClaudeFake {
  readonly calls: ClaudeCall[] = [];
  readonly problems: { at: string; what: string }[] = [];

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method !== "POST" || path !== "v1/messages") {
      this.problems.push({ at: new Date().toISOString(), what: `claude: no route ${req.method} ${path}` });
      return send(res, 404, { type: "error", error: { type: "not_found_error", message: `fake claude: ${path}` } });
    }
    const body = JSON.parse((await readBody(req)).toString()) as Body;
    const system = systemText(body);
    const text = userText(body);
    const kind = KINDS.find(([p]) => system === p || system.startsWith(p.slice(0, 200)))?.[1];
    this.calls.push({ at: new Date().toISOString(), kind: kind ?? "unknown", text: text.slice(0, 2000) });
    if (!kind) {
      this.problems.push({ at: new Date().toISOString(), what: `claude: unscripted system prompt "${system.slice(0, 80)}"` });
      return send(res, 500, { type: "error", error: { type: "api_error", message: "fake claude: unscripted call" } });
    }
    const json = JSON.stringify(answer(kind, text));
    const usage = { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const message = { id: `msg_e2e_${this.calls.length}`, type: "message", role: "assistant", model: "claude-e2e-fake", stop_sequence: null };
    if (!body.stream) {
      return send(res, 200, { ...message, content: [{ type: "text", text: json }], stop_reason: "end_turn", usage });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
    event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: json } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    event("message_stop", {});
    res.end();
  }
}
