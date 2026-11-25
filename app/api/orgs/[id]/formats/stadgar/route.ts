import { NextResponse, type NextRequest } from "next/server";
import { DRIVE_ID } from "@/lib/agenda/candidates";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { extractRequiredItems, type StadgarInput } from "@/lib/formats/stadgar";
import { getGoogleAuth, GoogleAuthLostError } from "@/lib/google/client";
import { driveApi } from "@/lib/google/docs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

const DOC_MIME = "application/vnd.google-apps.document";
const PDF_MIME = "application/pdf";
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const TOO_LARGE = "Filen är för stor (max 10 MB).";

const googleStatus = (err: unknown): number | undefined => {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const s = e?.response?.status ?? e?.status ?? e?.code;
  return typeof s === "number" ? s : undefined;
};

/**
 * Required agenda items from the förening's stadgar (Task C1). Body `{ fileId }`: a Google Doc
 * (read as plain text) or a PDF (at most 10 MB), picked by an admin and read with the admin's own
 * Google grant. → `{ requiredItems }`. Stores nothing; the stadgar text is never logged.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.");
  if (!isUuid(id)) return fail("not_found", 404, "Föreningen finns inte.");

  const role = await myRole(db, id);
  if (!role) return fail("not_found", 404, "Föreningen finns inte.");
  if (role !== "admin") return fail("forbidden", 403, "Bara administratörer kan byta mötesformat.");

  const body = (await request.json().catch(() => null)) as { fileId?: unknown } | null;
  const fileId = typeof body?.fileId === "string" ? body.fileId : "";
  if (!DRIVE_ID.test(fileId)) return fail("bad_request", 400, "Välj stadgarna i Google-väljaren igen.");

  let input: StadgarInput;
  try {
    const drive = driveApi(await getGoogleAuth(user.id));
    const meta = (await drive.files.get({ fileId, fields: "mimeType,size", supportsAllDrives: true })).data;
    if (meta.mimeType === DOC_MIME) {
      const res = await drive.files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" });
      input = { kind: "doc", text: String(res.data ?? "") };
    } else if (meta.mimeType === PDF_MIME) {
      if (Number(meta.size ?? 0) > MAX_PDF_BYTES) return fail("too_large", 413, TOO_LARGE);
      const res = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
      const bytes = Buffer.from(res.data as ArrayBuffer);
      if (bytes.length > MAX_PDF_BYTES) return fail("too_large", 413, TOO_LARGE);
      input = { kind: "pdf", base64: bytes.toString("base64") };
    } else {
      return fail("unsupported_type", 400, "Välj ett Google-dokument eller en PDF.");
    }
  } catch (err) {
    if (err instanceof GoogleAuthLostError) {
      return fail("google_auth_lost", 401, "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen.");
    }
    const status = googleStatus(err);
    if (status === 403 || status === 404) {
      return fail("doc_unreadable", 403, "Simon Says kan inte läsa filen. Välj den igen i Google-väljaren.");
    }
    console.error(`formats/stadgar: drive: ${(err as Error).message}`.slice(0, 200));
    return fail("google_unavailable", 502, "Vi nådde inte Google just nu. Försök igen om en liten stund.");
  }
  if (input.kind === "doc" && !input.text.trim()) return fail("empty", 400, "Dokumentet är tomt.");

  const res = await extractRequiredItems(input, { orgId: id });
  if (!res.ok) {
    if (res.error === "spend") {
      return fail("spend", 503, "Simon Says kan inte läsa stadgarna just nu. Försök igen i morgon.");
    }
    return fail(res.error, 502, "Simon Says kunde inte läsa stadgarna. Försök igen.");
  }
  console.info(`formats/stadgar: ${input.kind}, ${res.items.length} items`);
  return NextResponse.json({ requiredItems: res.items }, { headers: noStore });
}
