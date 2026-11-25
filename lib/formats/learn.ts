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
 * "learned" and the standard tone, task style and decision prefix. Then validated; null when it
 * is not a valid profile. Also used by the approve route (the profile comes back from the browser).
 */
export function forceLearned(raw: unknown): FormatProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  // Structured output says "no position" with null; the profile leaves the key out.
  const items = Array.isArray(obj.fixedAgendaItems)
    ? obj.fixedAgendaItems.map((i) =>
        i && typeof i === "object" && (i as Record<string, unknown>).position == null
          ? Object.fromEntries(Object.entries(i as Record<string, unknown>).filter(([k]) => k !== "position"))
          : i,
      )
    : obj.fixedAgendaItems;
  const parsed = FormatProfileSchema.safeParse({
    ...obj,
    fixedAgendaItems: items,
    kind: "learned",
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
      maxTokens: 4000,
      orgId: input.orgId,
      client: opts.client,
    });
    if (!res.ok) {
      if (res.reason === "spend") return { ok: false, error: "spend" };
      if (res.reason === "malformed") return { ok: false, error: "malformed" };
      if (res.reason === "stop_reason") return { ok: false, error: res.detail === "refusal" ? "refusal" : "error" };
      return { ok: false, error: "error" };
    }
    const profile = forceLearned(res.value.profile);
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
