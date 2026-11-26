import "server-only";
import type { OAuth2Client } from "google-auth-library";
import type { ProtocolSection } from "./doc-text";
import { MAX_DOC_CHARS } from "./extract-prompt";
import { fileCreatedDate, readProtocolDoc } from "./read-doc";

// Reads the Docs an admin picked, a few at a time, and splits each into meetings. Used by the
// estimate (only to measure) and by a batch job's creation (the text goes into the batch and is
// then dropped). Refused Docs carry a reason code (progress.ts REASON_MESSAGES).

const PARALLEL = 6;

export type PickedDoc =
  | { docId: string; ok: true; sections: ProtocolSection[]; fileDate: string | null }
  | { docId: string; ok: false; reason: "own_doc" | "empty" | "many-meetings" | "too-many" | "too_long" };

export async function readPickedDocs(
  auth: OAuth2Client,
  docIds: string[],
  opts: { own: Set<string>; skipTabIds: Set<string>; withFileDate?: boolean },
): Promise<PickedDoc[]> {
  const out: PickedDoc[] = [];
  for (let i = 0; i < docIds.length; i += PARALLEL) {
    out.push(
      ...(await Promise.all(
        docIds.slice(i, i + PARALLEL).map(async (docId): Promise<PickedDoc> => {
          if (opts.own.has(docId)) return { docId, ok: false, reason: "own_doc" };
          const { split } = await readProtocolDoc(auth, docId, { skipTabIds: opts.skipTabIds });
          if (!split.ok) return { docId, ok: false, reason: split.reason };
          if (split.sections.some((s) => s.text.length > MAX_DOC_CHARS)) return { docId, ok: false, reason: "too_long" };
          // The fallback date when a meeting holds none (the cron cannot ask Google later).
          const fileDate =
            opts.withFileDate && split.sections.some((s) => !s.date) ? await fileCreatedDate(auth, docId).catch(() => null) : null;
          return { docId, ok: true, sections: split.sections, fileDate };
        }),
      )),
    );
  }
  return out;
}
