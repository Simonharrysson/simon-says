import { z } from "zod";
import type { ItemRole } from "@/lib/db/types";

export type FormatKind = "veckomote" | "styrelseprotokoll" | "enkel" | "learned";

export interface FixedItem {
  key: string;
  label: string;
  role: ItemRole;
  position?: "last";
}

/** The format profile JSON stored in `format_profiles.profile` (spec "Format profile"). */
export interface FormatProfile {
  kind: FormatKind;
  title: string;
  infoTable: string[] | null;
  agendaHeading: string | null;
  fixedAgendaItems: FixedItem[];
  numbering: "numbered" | "paragraph" | "none";
  tasksSection: { label: string; groupBy: "role" | "person" } | null;
  notesSection: { label: string } | null;
  decisionPrefix: string;
  taskStyle: "role-first";
  tone: "full-sentences";
  signatures: string[] | null;
  requiredItems: string[];
  /**
   * Hide the Må-runda from the notes (detector + masking). Opt-in and experimental: the detector's
   * precision is not proven, so it may hide real discussion. Absent (every stored profile from
   * before) = off. Written only when true.
   */
  hideCheckin?: boolean;
}

const label = z.string().trim().min(1).max(80);
const role = z.enum(["procedural", "checkin", "followup", "other", "topic"]);

const fixedItem = z.object({
  key: z.string().trim().min(1).max(40),
  label,
  role,
  position: z.literal("last").optional(),
});

export const FormatProfileSchema = z
  .object({
    kind: z.enum(["veckomote", "styrelseprotokoll", "enkel", "learned"]),
    title: label,
    infoTable: z.array(label).max(8).nullable(),
    agendaHeading: label.nullable(),
    fixedAgendaItems: z.array(fixedItem).max(20),
    numbering: z.enum(["numbered", "paragraph", "none"]),
    tasksSection: z.object({ label, groupBy: z.enum(["role", "person"]) }).nullable(),
    notesSection: z.object({ label }).nullable(),
    decisionPrefix: z.string().trim().min(1).max(80),
    taskStyle: z.literal("role-first"),
    tone: z.literal("full-sentences"),
    signatures: z.array(label).max(8).nullable(),
    requiredItems: z.array(label).max(15),
    hideCheckin: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    const keys = new Set<string>();
    for (const item of p.fixedAgendaItems) {
      if (keys.has(item.key)) ctx.addIssue({ code: "custom", message: `duplicate key ${item.key}`, path: ["fixedAgendaItems"] });
      keys.add(item.key);
    }
    for (const r of ["checkin", "followup"] as const) {
      if (p.fixedAgendaItems.filter((i) => i.role === r).length > 1) {
        ctx.addIssue({ code: "custom", message: `more than one ${r} item`, path: ["fixedAgendaItems"] });
      }
    }
  });

/** Validates untrusted JSON (DB row, Claude output). Null when it is not a valid profile. */
export function parseProfile(json: unknown): FormatProfile | null {
  const r = FormatProfileSchema.safeParse(json);
  return r.success ? (r.data as FormatProfile) : null;
}

/** The format hides the Må-runda from the notes (opt-in, see `FormatProfile.hideCheckin`). */
export const hidesCheckin = (p: Pick<FormatProfile, "hideCheckin">): boolean => p.hideCheckin === true;

/**
 * The agenda roles a meeting stores. With hiding off (the default) a Må-runda item becomes an
 * ordinary item (role "procedural": notes may land under it, still not a dashboard topic), so
 * there is no checkin role in the meeting: no detector call, no masking, no hidden Doc text, no
 * ban on notes under it. With hiding on the roles are kept as matched.
 */
export function meetingRoles(roles: Record<string, ItemRole>, profile: Pick<FormatProfile, "hideCheckin">): Record<string, ItemRole> {
  if (hidesCheckin(profile)) return roles;
  return Object.fromEntries(Object.entries(roles).map(([k, r]) => [k, r === "checkin" ? "procedural" : r]));
}
