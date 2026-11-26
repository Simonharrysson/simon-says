"use client";

import { useState } from "react";
import { PickerError, usePicker, type PickedFile } from "@/components/google/Picker";
import { Banner } from "@/components/ui/Banner";
import { Button, Spinner } from "@/components/ui/button";
import { formatUsd, MAX_IMPORT_DOCS } from "@/lib/history/limits";
import { plural } from "@/lib/format";

// "Läs in gamla protokoll" on the Översikt's goals card (todo #7; the onboarding's step 5 comes
// later): pick old protocols → see what it costs and that the TEXT goes to Claude → confirm →
// one request per protocol with progress → the caller asks for goals over the whole history.

export interface ImportEstimate {
  protocols: number;
  tooLong: number;
  importUsd: number;
  digestUsd: number;
  totalUsd: number;
}

export type ImportPhase =
  | { phase: "intro" }
  | { phase: "estimating"; files: PickedFile[] }
  | { phase: "confirm"; files: PickedFile[]; estimate: ImportEstimate }
  | { phase: "importing"; total: number; done: number; failed: number }
  | { phase: "error"; message: string };

export interface ImportResult {
  imported: number;
  failed: number;
  /** The import stopped early (the daily limit or a lost Google grant). */
  stopped: string | null;
}

/** What the admin reads before confirming: the text goes to Claude, only short lines are kept. */
export function PrivacyNote() {
  return (
    <p className="text-sm text-ink-2 max-w-[68ch]">
      Simon Says skickar <strong>protokollens text</strong> till Claude (Anthropic) för att plocka ut datum, beslut,
      uppgifter och läget för det ni har jobbat med. Till skillnad från när Simon Says lär sig ert mötesformat läses alltså
      hela texten. Hos oss sparas bara korta rader, utan namn, aldrig dokumenten. Du kan ta bort dem när som helst.
    </p>
  );
}

export function HistoryImport({
  orgId,
  initial,
  onDone,
  onCancel,
}: {
  orgId: string;
  /** /design only. */
  initial?: ImportPhase;
  onDone: (result: ImportResult) => void;
  onCancel: () => void;
}) {
  const picker = usePicker();
  const [view, setView] = useState<ImportPhase>(initial ?? { phase: "intro" });

  const pick = async () => {
    let files: PickedFile[] | null;
    try {
      files = await picker.open({ mode: "docs-multi", title: `Välj föreningens gamla protokoll (högst ${MAX_IMPORT_DOCS})` });
    } catch (err) {
      setView({ phase: "error", message: err instanceof PickerError ? err.message : "Google-väljaren kunde inte öppnas. Försök igen." });
      return;
    }
    if (!files?.length) return;
    if (files.length > MAX_IMPORT_DOCS) {
      setView({ phase: "error", message: `Välj högst ${MAX_IMPORT_DOCS} protokoll åt gången.` });
      return;
    }
    setView({ phase: "estimating", files });
    try {
      const res = await fetch(`/api/orgs/${orgId}/history/estimate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docIds: files.map((f) => f.id) }),
      });
      const json = (await res.json().catch(() => null)) as (ImportEstimate & { message?: string }) | null;
      if (!res.ok || !json || typeof json.totalUsd !== "number") {
        setView({ phase: "error", message: json?.message ?? "Simon Says kunde inte läsa dokumenten. Försök igen." });
        return;
      }
      setView({ phase: "confirm", files, estimate: json });
    } catch {
      setView({ phase: "error", message: "Vi nådde inte servern. Kontrollera nätet och försök igen." });
    }
  };

  const run = async (files: PickedFile[]) => {
    let done = 0;
    let failed = 0;
    let stopped: string | null = null;
    setView({ phase: "importing", total: files.length, done, failed });
    for (const f of files) {
      try {
        const res = await fetch(`/api/orgs/${orgId}/history/import`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ docId: f.id }),
        });
        if (res.ok) done++;
        else {
          const json = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
          failed++;
          // These stop every further protocol too: no point in trying the rest.
          if (res.status === 429 || res.status === 503 || json?.error === "google_auth_lost") {
            stopped = json?.message ?? "Inläsningen stoppades. Försök igen senare.";
            break;
          }
        }
      } catch {
        failed++;
      }
      setView({ phase: "importing", total: files.length, done, failed });
    }
    onDone({ imported: done, failed, stopped });
  };

  if (view.phase === "importing") {
    const pctDone = Math.round(((view.done + view.failed) / view.total) * 100);
    return (
      <div className="flex flex-col gap-3" role="status" aria-live="polite">
        <p className="text-sm text-ink-2">
          <Spinner className="align-[-0.125em]" /> Läser {Math.min(view.done + view.failed + 1, view.total)} av {view.total} protokoll …
        </p>
        <div className="h-2 w-full max-w-[28rem] overflow-hidden rounded-full bg-sunk" aria-hidden>
          <div className="h-full rounded-full bg-ink-2 transition-[width] duration-300" style={{ width: `${pctDone}%` }} />
        </div>
        {view.failed > 0 && <p className="text-sm text-ink-3">{plural(view.failed, "protokoll", "protokoll")} gick inte att läsa.</p>}
      </div>
    );
  }

  if (view.phase === "confirm") {
    const e = view.estimate;
    return (
      <div className="flex flex-col gap-4">
        <p className="font-medium">
          {plural(e.protocols, "protokoll", "protokoll")} valda
          {e.tooLong > 0 && <span className="font-normal text-ink-3"> ({plural(e.tooLong, "dokument", "dokument")} är för långa och hoppas över)</span>}
        </p>
        <PrivacyNote />
        <p className="text-sm text-ink-3">
          Kostnad för Simon Says: {formatUsd(e.totalUsd)} (läsa protokollen {formatUsd(e.importUsd)}, förslag på mål {formatUsd(e.digestUsd)}).
          Sedan föreslår Simon Says mål utifrån hela historiken, och du godkänner dem innan någon annan ser dem.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={e.protocols === 0} onClick={() => run(view.files)}>
            {`Skicka till Claude och läs in ${plural(e.protocols, "protokoll", "protokoll")}`}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Avbryt
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[68ch]">
        Välj föreningens gamla protokoll i Google Drive. Simon Says läser dem i tidsordning och föreslår vilka mål ni jobbar
        mot nu, vilka ni har nått och vilka som har runnit ut i sanden.
      </p>
      <PrivacyNote />
      {view.phase === "error" && <Banner tone="danger">{view.message}</Banner>}
      {view.phase === "estimating" ? (
        <p className="text-sm text-ink-3" role="status" aria-live="polite">
          <Spinner className="align-[-0.125em]" /> Räknar på {plural(view.files.length, "protokoll", "protokoll")} … Inget skickas än.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={pick}>
            Välj protokoll …
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Avbryt
          </Button>
        </div>
      )}
    </div>
  );
}
