import "server-only";
import { z } from "zod";
import type { NotesClient, NotesUsage } from "@/lib/notes/engine";
import { oneShot } from "@/lib/notes/oneshot";
import { buildLearnUserText, LEARN_JSON_SCHEMA, LEARN_SYSTEM_PROMPT } from "./learn-prompt";
import { FormatProfileSchema, type FormatProfile } from "./schema";
import { VECKOMOTE } from "./standard";
import type { DocStructure } from "./structure";

// Propose a learned format from the structure of picked Docs (spec "Learning a format", Task
// B1): one Claude call, usage recorded on the org, nothing stored. The answer's style fields are
// overwritten with the standard values (G4: never copy poor quality), then the profile is
// validated; zod drops any key the schema does not know.

export type ProposeResult =
  | { ok: true; profile: FormatProfile; explanation: string; qualityNote: string; usage: NotesUsage }
  | { ok: false; error: "spend" | "refusal" | "malformed" | "error" };

const MAX_NOTE = 600;

const AnswerSchema = z.object({
  profile: z.record(z.string(), z.unknown()),
  explanation: z.string(),
  quality_note: z.string(),
});

/**
 * The fields every learned profile gets regardless of what was proposed or edited: kind
 * "learned" (or "styrelseprotokoll" for one approved with the stadgar's items, C1) and the
 * standard tone, task style and decision prefix. Then validated; null when it is not a valid
 * profile. Also used by the approve route (the profile comes back from the browser).
 */
export function forceLearned(raw: unknown, kind: "learned" | "styrelseprotokoll" = "learned"): FormatProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  // Structured output says "no position" with null; the profile leaves the key out.
  let items = Array.isArray(obj.fixedAgendaItems)
    ? obj.fixedAgendaItems.map((i) =>
        i && typeof i === "object" && (i as Record<string, unknown>).position == null
          ? Object.fromEntries(Object.entries(i as Record<string, unknown>).filter(([k]) => k !== "position"))
          : i,
      )
    : obj.fixedAgendaItems;
  // Repaired, not refused (final review R3 minor): a repeated key gets a suffix, a second
  // check-in or follow-up item becomes a topic.
  if (Array.isArray(items)) {
    const keys = new Set<string>();
    const seenRole = new Set<string>();
    items = items.map((i) => {
      if (!i || typeof i !== "object") return i;
      const item = { ...(i as Record<string, unknown>) };
      if (typeof item.key === "string") {
        const base = item.key.trim().slice(0, 36);
        let key = base;
        for (let n = 2; keys.has(key); n++) key = `${base}-${n}`;
        keys.add(key);
        item.key = key;
      }
      if (item.role === "checkin" || item.role === "followup") {
        if (seenRole.has(item.role)) item.role = "topic";
        else seenRole.add(item.role as string);
      }
      return item;
    });
  }
  const { hideCheckin, ...rest } = obj;
  const parsed = FormatProfileSchema.safeParse({
    ...rest,
    // Må-runda hiding is opt-in: stored only when true (absent = off).
    ...(hideCheckin === true ? { hideCheckin: true } : {}),
    fixedAgendaItems: items,
    kind,
    tone: VECKOMOTE.tone,
    taskStyle: VECKOMOTE.taskStyle,
    decisionPrefix: VECKOMOTE.decisionPrefix,
  });
  return parsed.success ? (parsed.data as FormatProfile) : null;
}

const clean = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);

export async function proposeFormat(
  input: { orgId: string; docs: { isTemplate: boolean; structure: DocStructure }[] },
  opts: { client?: NotesClient } = {},
): Promise<ProposeResult> {
  try {
    const res = await oneShot({
      label: "format learn",
      system: LEARN_SYSTEM_PROMPT,
      user: buildLearnUserText(input.docs),
      jsonSchema: LEARN_JSON_SCHEMA,
      schema: AnswerSchema,
      // Thinking counts toward max_tokens: room for it and the profile (final review R3 minor).
      maxTokens: 16_000,
      orgId: input.orgId,
      client: opts.client,
    });
    if (!res.ok) {
      if (res.reason === "spend") return { ok: false, error: "spend" };
      if (res.reason === "malformed") return { ok: false, error: "malformed" };
      if (res.reason === "stop_reason") return { ok: false, error: res.detail === "refusal" ? "refusal" : "error" };
      return { ok: false, error: "error" };
    }
    // Required items come from the stadgar, never from minutes.
    const profile = forceLearned({ ...res.value.profile, requiredItems: [], hideCheckin: undefined });
    if (!profile) {
      console.error("format learn: proposed profile is invalid");
      return { ok: false, error: "malformed" };
    }
    return {
      ok: true,
      profile,
      explanation: clean(res.value.explanation),
      qualityNote: clean(res.value.quality_note),
      usage: res.usage,
    };
  } catch (e) {
    console.error(`format learn: ${(e as Error).message}`.slice(0, 200));
    return { ok: false, error: "error" };
  }
}
