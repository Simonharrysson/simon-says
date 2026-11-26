import type { AgendaAccess } from "@/lib/agenda/access";

// A prepared agenda whose Doc is gone. drive.file decides what "not found" means: only the
// preparer's own grant is sure to see a Doc Simon Says created for them, so their not_found is a
// deleted Doc; another member's not_found only means their grant has not opened it yet. A
// trashed Doc is gone for everyone. Pure.

export type PreparedDocState = "ok" | "gone" | "no_access";

export function preparedDocState(access: AgendaAccess, viewerIsPreparer: boolean): PreparedDocState {
  if (access.ok) return "ok";
  if (access.error === "trashed") return "gone";
  if (access.error === "not_found") return viewerIsPreparer ? "gone" : "no_access";
  return "no_access";
}
