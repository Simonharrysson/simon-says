import "server-only";
import { GoogleAuthLostError } from "@/lib/google/client";
import { DriveAccountLostError, pickerAuth } from "@/lib/google/drive-account";
import { driveApi } from "@/lib/google/docs";
import type { StadgarInput } from "./stadgar";

// Reads the stadgar the admin picked (a Google Doc as plain text, or a PDF of at most 10 MB) with
// the grant whose Picker picked them (the admin's own, or the förening's Drive account for the admin
// who connected it, 0070). Shared by "Lägg in punkter från stadgarna" (C1) and onboarding
// step 4. The text is never stored or logged.

const DOC_MIME = "application/vnd.google-apps.document";
const PDF_MIME = "application/pdf";
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const TOO_LARGE = "Filen är för stor (max 10 MB).";

export type StadgarFile = { ok: true; input: StadgarInput } | { ok: false; error: string; status: number; message: string };

const googleStatus = (err: unknown): number | undefined => {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const s = e?.response?.status ?? e?.status ?? e?.code;
  return typeof s === "number" ? s : undefined;
};

export async function readStadgarFile(userId: string, fileId: string, logLabel: string, orgId: string | null = null): Promise<StadgarFile> {
  let input: StadgarInput;
  try {
    const drive = driveApi((await pickerAuth(userId, orgId)).auth);
    const meta = (await drive.files.get({ fileId, fields: "mimeType,size", supportsAllDrives: true })).data;
    if (meta.mimeType === DOC_MIME) {
      const res = await drive.files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" });
      input = { kind: "doc", text: String(res.data ?? "") };
    } else if (meta.mimeType === PDF_MIME) {
      if (Number(meta.size ?? 0) > MAX_PDF_BYTES) return { ok: false, error: "too_large", status: 413, message: TOO_LARGE };
      const res = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
      const bytes = Buffer.from(res.data as ArrayBuffer);
      if (bytes.length > MAX_PDF_BYTES) return { ok: false, error: "too_large", status: 413, message: TOO_LARGE };
      input = { kind: "pdf", base64: bytes.toString("base64") };
    } else {
      return { ok: false, error: "unsupported_type", status: 400, message: "Välj ett Google-dokument eller en PDF." };
    }
  } catch (err) {
    if (err instanceof DriveAccountLostError) {
      return { ok: false, error: "drive_account_lost", status: 409, message: "Drive-kopplingen behöver förnyas. Välj ”Förnya” vid mötesmappen." };
    }
    if (err instanceof GoogleAuthLostError) {
      return { ok: false, error: "google_auth_lost", status: 401, message: "Kopplingen till ditt Google-konto har gått ut. Logga ut och in igen." };
    }
    const status = googleStatus(err);
    if (status === 403 || status === 404) {
      return { ok: false, error: "doc_unreadable", status: 403, message: "Simon Says kan inte läsa filen. Välj den igen i Google-väljaren." };
    }
    console.error(`${logLabel}: drive: ${(err as Error).message}`.slice(0, 200));
    return { ok: false, error: "google_unavailable", status: 502, message: "Vi nådde inte Google just nu. Försök igen om en liten stund." };
  }
  if (input.kind === "doc" && !input.text.trim()) return { ok: false, error: "empty", status: 400, message: "Dokumentet är tomt." };
  return { ok: true, input };
}
