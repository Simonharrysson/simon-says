"use client";

import { useState } from "react";
import { PickerError, usePicker, type PickedFile } from "@/components/google/Picker";
import { Banner } from "@/components/ui/Banner";
import { Button, Spinner } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatUsd, MAX_IMPORT_DOCS } from "@/lib/history/limits";
import { plural } from "@/lib/format";

// "Läs in gamla protokoll" on the Översikt's goals card (todo #7; the onboarding's step 5 comes
// later): pick old protocols → see what it costs, which Docs hold several meetings or cannot be
// read, and that the TEXT goes to Claude → confirm → one request per meeting with progress →
// correct the dates that came from a file's creation date → the caller asks for goals.

export type EstimateDoc = { docId: string; sections: number } | { docId: string; error: string; message: string };

export interface ImportEstimate {
  docs: EstimateDoc[];
  protocols: number;
  importUsd: number;
  digestUsd: number;
  totalUsd: number;
}

/** A meeting whose date fell back to the Doc's creation date: the admin may correct it. */
export interface FileDated {
  protocolId: string;
  label: string;
  date: string;
}

export type ImportPhase =
  | { phase: "intro" }
  | { phase: "estimating"; files: PickedFile[] }
  | { phase: "confirm"; files: PickedFile[]; estimate: ImportEstimate }
  | { phase: "importing"; total: number; done: number; failed: number }
  | { phase: "dates"; fileDated: FileDated[]; result: ImportResult }
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
      if (!res.ok || !json || typeof json.totalUsd !== "number" || !Array.isArray(json.docs)) {
        setView({ phase: "error", message: json?.message ?? "Simon Says kunde inte läsa dokumenten. Försök igen." });
        return;
      }
      setView({ phase: "confirm", files, estimate: json });
    } catch {
      setView({ phase: "error", message: "Vi nådde inte servern. Kontrollera nätet och försök igen." });
    }
  };

  const run = async (files: PickedFile[], estimate: ImportEstimate) => {
    const jobs = estimate.docs.flatMap((d) => {
      if (!("sections" in d)) return [];
      const name = files.find((f) => f.id === d.docId)?.name ?? "Dokument";
      return Array.from({ length: d.sections }, (_, section) => ({
        docId: d.docId,
        section,
        sections: d.sections,
        label: d.sections > 1 ? `${name}, möte ${section + 1} av ${d.sections}` : name,
      }));
    });
    let done = 0;
    let failed = 0;
    let stopped: string | null = null;
    const fileDated: FileDated[] = [];
    setView({ phase: "importing", total: jobs.length, done, failed });
    for (const j of jobs) {
      try {
        const res = await fetch(`/api/orgs/${orgId}/history/import`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ docId: j.docId, section: j.section, sections: j.sections }),
        });
        const json = (await res.json().catch(() => null)) as { error?: string; message?: string; protocolId?: string; date?: string; dateFrom?: string } | null;
        if (res.ok) {
          done++;
          if (json?.dateFrom === "file" && json.protocolId && json.date) fileDated.push({ protocolId: json.protocolId, label: j.label, date: json.date });
        } else {
          failed++;
          // These stop every further meeting too: no point in trying the rest.
          if (res.status === 429 || res.status === 503 || json?.error === "google_auth_lost") {
            stopped = json?.message ?? "Inläsningen stoppades. Försök igen senare.";
            break;
          }
        }
      } catch {
        failed++;
      }
      setView({ phase: "importing", total: jobs.length, done, failed });
    }
    const result = { imported: done, failed, stopped };
    if (fileDated.length) setView({ phase: "dates", fileDated, result });
    else onDone(result);
  };

  if (view.phase === "dates") return <FileDates orgId={orgId} items={view.fileDated} onDone={() => onDone(view.result)} />;

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
    const name = (id: string) => view.files.find((f) => f.id === id)?.name ?? "Dokument";
    const refused = e.docs.filter((d): d is Extract<EstimateDoc, { error: string }> => "error" in d);
    const multi = e.docs.filter((d): d is Extract<EstimateDoc, { sections: number }> => "sections" in d && d.sections > 1);
    return (
      <div className="flex flex-col gap-4">
        <p className="font-medium">
          {plural(e.protocols, "möte", "möten")} att läsa in
          {multi.length > 0 && <span className="font-normal text-ink-3"> ({multi.map((d) => `${name(d.docId)}: ${d.sections} möten`).join(", ")})</span>}
        </p>
        {refused.length > 0 && (
          <Banner tone="warning" title={`${plural(refused.length, "dokument", "dokument")} hoppas över`} live={false}>
            <ul className="flex flex-col gap-1">
              {refused.map((d) => (
                <li key={d.docId}>
                  <strong>{name(d.docId)}</strong>: {d.message}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        <PrivacyNote />
        <p className="text-sm text-ink-3">
          Kostnad för Simon Says: {formatUsd(e.totalUsd)} (läsa protokollen {formatUsd(e.importUsd)}, förslag på mål över hela historiken {formatUsd(e.digestUsd)}).
          Sedan föreslår Simon Says mål, och du godkänner dem innan någon annan ser dem.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={e.protocols === 0} onClick={() => run(view.files, e)}>
            {`Skicka till Claude och läs in ${plural(e.protocols, "möte", "möten")}`}
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
        Välj föreningens gamla protokoll i Google Drive. Ett dokument kan innehålla ett möte eller flera (ett per flik eller
        under var sin daterad rubrik). Simon Says läser dem i tidsordning och föreslår vilka mål ni jobbar mot nu, vilka ni
        har nått och vilka som har runnit ut i sanden.
      </p>
      <PrivacyNote />
      {view.phase === "error" && <Banner tone="danger">{view.message}</Banner>}
      {view.phase === "estimating" ? (
        <p className="text-sm text-ink-3" role="status" aria-live="polite">
          <Spinner className="align-[-0.125em]" /> Räknar på {plural(view.files.length, "dokument", "dokument")} … Inget skickas än.
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

/** "Datum från filen — ändra?": meetings dated by the Doc's creation date, correctable before the goals. */
function FileDates({ orgId, items, onDone }: { orgId: string; items: FileDated[]; onDone: () => void }) {
  const [dates, setDates] = useState(() => items.map((i) => i.date));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      for (let k = 0; k < items.length; k++) {
        if (dates[k] === items[k].date) continue;
        const res = await fetch(`/api/orgs/${orgId}/history`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ protocolId: items[k].protocolId, date: dates[k] }),
        });
        if (!res.ok) {
          const json = (await res.json().catch(() => null)) as { message?: string } | null;
          setMessage(`${items[k].label}: ${json?.message ?? "Datumet kunde inte sparas."}`);
          return;
        }
      }
      onDone();
    } catch {
      setMessage("Vi nådde inte servern. Kontrollera nätet och försök igen.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[68ch]">
        {plural(items.length, "protokoll saknar", "protokoll saknar")} datum i texten. Simon Says använde dokumentets
        skapandedatum, som kan vara fel om dokumentet kopierats. Ändra om det behövs: målen bygger på ordningen.
      </p>
      <ul className="flex flex-col gap-3">
        {items.map((it, k) => (
          <li key={it.protocolId} className="flex flex-wrap items-center gap-3">
            <Label htmlFor={`fd-${it.protocolId}`} className="min-w-[14rem] font-medium">
              {it.label} <span className="font-normal text-ink-3">(datum från filen — ändra?)</span>
            </Label>
            <Input
              id={`fd-${it.protocolId}`}
              type="date"
              max={today}
              value={dates[k]}
              className="w-auto"
              onChange={(e) => setDates((ds) => ds.map((d, j) => (j === k ? e.target.value : d)))}
            />
          </li>
        ))}
      </ul>
      {message && <Banner tone="danger">{message}</Banner>}
      <div>
        <Button variant="primary" loading={busy} disabled={dates.some((d) => !d || d > today)} onClick={save}>
          Fortsätt till målen
        </Button>
      </div>
    </div>
  );
}
