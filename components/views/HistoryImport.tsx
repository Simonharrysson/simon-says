"use client";

import { useState } from "react";
import { requestDriveAccess } from "@/app/(app)/orgs/drive-access";
import { PickerError, usePicker, type PickedFile } from "@/components/google/Picker";
import { Banner } from "@/components/ui/Banner";
import { Button, Spinner } from "@/components/ui/button";
import { IconCheck, IconGoogle } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { DriveFolder, ImportFile } from "@/lib/history/drive-list";
import { formatUsd, MAX_IMPORT_DOCS } from "@/lib/history/limits";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FileStep, FolderStep } from "./DriveSteps";

// "Läs in gamla protokoll" on the Översikt's goals card (todo #7): the admin gives Simon Says
// read access to their Drive once (incremental consent, drive.readonly, only here) → ticks the
// folders with the protocols → ticks the meetings in them (Simon Says' own Docs, templates and
// already imported ones are marked) → sees what it costs and that the TEXT goes to Claude →
// confirm → one request per meeting with a progress list → corrects dates that came from a
// file's creation date → the caller asks for goals. An admin who says no to the read access can
// still pick Docs one by one in the Google Picker (the old flow).

/** What the page knows for the import: the admin's grant and the förening's meeting folder. */
export interface ImportAccess {
  driveReadonly: boolean;
  meetingFolder: { id: string; name: string } | null;
}

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
  /** The grant lacks drive.readonly: explain, "Ge åtkomst". `consent`: back from Google with a no or an error. */
  | { phase: "access"; consent?: "nej" | "fel" }
  | { phase: "folders"; selected?: DriveFolder[]; subfolders?: boolean }
  | { phase: "files"; folders: DriveFolder[]; subfolders: boolean; initialFiles?: { files: ImportFile[]; truncated: boolean; folders: number } }
  /** The fallback without read access: the Google Picker, one Doc at a time. */
  | { phase: "picker" }
  | { phase: "estimating"; files: PickedFile[]; back: Back }
  | { phase: "confirm"; files: PickedFile[]; estimate: ImportEstimate; back: Back }
  | { phase: "importing"; jobs: Job[] }
  | { phase: "dates"; fileDated: FileDated[]; result: ImportResult }
  | { phase: "error"; message: string; back: Back };

/** Where "Tillbaka" goes from the cost step. */
type Back = { phase: "files"; folders: DriveFolder[]; subfolders: boolean } | { phase: "picker" };

export interface Job {
  docId: string;
  section: number;
  sections: number;
  label: string;
  state: "waiting" | "reading" | "done" | "failed";
  message?: string;
}

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

/** Why Simon Says asks for read access to Drive, in one calm paragraph (shown before "Ge åtkomst"). */
export function DriveAccessNote() {
  return (
    <p className="max-w-[68ch]">
      För att du ska kunna välja mappar och se mötena i dem behöver Simon Says läsrättighet till din Google Drive. Den används
      bara här: Simon Says visar dina mappar och namnen på mötena i de mappar du väljer, öppnar bara de protokoll du kryssar
      i, och sparar inget annat från din Drive. Du kan ta bort åtkomsten när som helst i ditt Google-konto.
    </p>
  );
}

export function HistoryImport({
  orgId,
  access,
  consent,
  initial,
  onDone,
  onCancel,
}: {
  orgId: string;
  access: ImportAccess;
  /** Back from Google's consent screen. */
  consent?: "ok" | "nej" | "fel";
  /** /design only. */
  initial?: ImportPhase;
  onDone: (result: ImportResult) => void;
  onCancel: () => void;
}) {
  const picker = usePicker();
  const [view, setView] = useState<ImportPhase>(
    initial ?? (access.driveReadonly ? { phase: "folders" } : { phase: "access", ...(consent === "nej" || consent === "fel" ? { consent } : {}) }),
  );
  const needsAccess = () => setView({ phase: "access" });

  const estimate = async (files: PickedFile[], back: Back) => {
    setView({ phase: "estimating", files, back });
    try {
      const res = await fetch(`/api/orgs/${orgId}/history/estimate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docIds: files.map((f) => f.id) }),
      });
      const json = (await res.json().catch(() => null)) as (ImportEstimate & { message?: string }) | null;
      if (!res.ok || !json || typeof json.totalUsd !== "number" || !Array.isArray(json.docs)) {
        setView({ phase: "error", message: json?.message ?? "Simon Says kunde inte läsa dokumenten. Försök igen.", back });
        return;
      }
      setView({ phase: "confirm", files, estimate: json, back });
    } catch {
      setView({ phase: "error", message: "Vi nådde inte servern. Kontrollera nätet och försök igen.", back });
    }
  };

  const pick = async () => {
    let files: PickedFile[] | null;
    try {
      files = await picker.open({ mode: "docs-multi", title: `Välj föreningens gamla protokoll (högst ${MAX_IMPORT_DOCS})` });
    } catch (err) {
      setView({ phase: "error", message: err instanceof PickerError ? err.message : "Google-väljaren kunde inte öppnas. Försök igen.", back: { phase: "picker" } });
      return;
    }
    if (!files?.length) return;
    if (files.length > MAX_IMPORT_DOCS) {
      setView({ phase: "error", message: `Välj högst ${MAX_IMPORT_DOCS} protokoll åt gången.`, back: { phase: "picker" } });
      return;
    }
    await estimate(files, { phase: "picker" });
  };

  const run = async (files: PickedFile[], e: ImportEstimate) => {
    const jobs: Job[] = e.docs.flatMap((d) => {
      if (!("sections" in d)) return [];
      const name = files.find((f) => f.id === d.docId)?.name ?? "Dokument";
      return Array.from({ length: d.sections }, (_, section) => ({
        docId: d.docId,
        section,
        sections: d.sections,
        label: d.sections > 1 ? `${name}, möte ${section + 1} av ${d.sections}` : name,
        state: "waiting" as const,
      }));
    });
    let done = 0;
    let failed = 0;
    let stopped: string | null = null;
    const fileDated: FileDated[] = [];
    const show = () => setView({ phase: "importing", jobs: jobs.map((j) => ({ ...j })) });
    for (const j of jobs) {
      j.state = "reading";
      show();
      try {
        const res = await fetch(`/api/orgs/${orgId}/history/import`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ docId: j.docId, section: j.section, sections: j.sections }),
        });
        const json = (await res.json().catch(() => null)) as { error?: string; message?: string; protocolId?: string; date?: string; dateFrom?: string } | null;
        if (res.ok) {
          done++;
          j.state = "done";
          if (json?.dateFrom === "file" && json.protocolId && json.date) fileDated.push({ protocolId: json.protocolId, label: j.label, date: json.date });
        } else {
          failed++;
          j.state = "failed";
          j.message = json?.message;
          // These stop every further meeting too: no point in trying the rest.
          if (res.status === 429 || res.status === 503 || json?.error === "google_auth_lost") {
            stopped = json?.message ?? "Inläsningen stoppades. Försök igen senare.";
            break;
          }
        }
      } catch {
        failed++;
        j.state = "failed";
        j.message = "Vi nådde inte servern.";
      }
    }
    show();
    const result = { imported: done, failed, stopped };
    if (fileDated.length) setView({ phase: "dates", fileDated, result });
    else onDone(result);
  };

  if (view.phase === "dates") return <FileDates orgId={orgId} items={view.fileDated} onDone={() => onDone(view.result)} />;
  if (view.phase === "importing") return <Progress jobs={view.jobs} />;

  if (view.phase === "folders") {
    return (
      <FolderStep
        orgId={orgId}
        meetingFolder={access.meetingFolder}
        initialSelected={view.selected}
        initialSubfolders={view.subfolders}
        onNext={(folders, subfolders) => setView({ phase: "files", folders, subfolders })}
        onCancel={onCancel}
        onNeedsAccess={needsAccess}
      />
    );
  }

  if (view.phase === "files") {
    const back: Back = { phase: "files", folders: view.folders, subfolders: view.subfolders };
    return (
      <FileStep
        orgId={orgId}
        folders={view.folders}
        subfolders={view.subfolders}
        initialFiles={view.initialFiles}
        onBack={() => setView({ phase: "folders", selected: view.folders, subfolders: view.subfolders })}
        onNext={(files) => estimate(files.map((f) => ({ id: f.id, name: f.name, mimeType: "application/vnd.google-apps.document" })), back)}
        onNeedsAccess={needsAccess}
      />
    );
  }

  const goBack = (b: Back) => setView(b.phase === "picker" ? { phase: "picker" } : { phase: "files", folders: b.folders, subfolders: b.subfolders });

  if (view.phase === "estimating") {
    return (
      <p className="text-sm text-ink-3" role="status" aria-live="polite">
        <Spinner className="align-[-0.125em]" /> Räknar på {plural(view.files.length, "dokument", "dokument")} … Inget skickas än.
      </p>
    );
  }

  if (view.phase === "error") {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="danger">{view.message}</Banner>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => goBack(view.back)}>
            Tillbaka
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Avbryt
          </Button>
        </div>
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
            {`Läs in ${plural(e.protocols, "protokoll", "protokoll")}`}
          </Button>
          <Button variant="ghost" onClick={() => goBack(view.back)}>
            Tillbaka
          </Button>
        </div>
      </div>
    );
  }

  if (view.phase === "access") {
    return (
      <div className="flex flex-col gap-4">
        {view.consent === "nej" ? (
          <Banner tone="neutral" title="Simon Says fick ingen läsrättighet" live={false}>
            Det går bra. Du kan ge åtkomst senare, eller välja protokollen ett och ett i Googles egen väljare.
          </Banner>
        ) : view.consent === "fel" ? (
          <Banner tone="danger">Google svarade inte som väntat. Försök igen om en liten stund.</Banner>
        ) : null}
        <DriveAccessNote />
        <form action={requestDriveAccess} className="flex flex-wrap gap-2">
          <input type="hidden" name="orgId" value={orgId} />
          <SubmitButton variant="primary" icon={<IconGoogle size={16} />} pendingLabel="Öppnar Google …">
            Ge åtkomst
          </SubmitButton>
          {view.consent === "nej" && (
            <Button type="button" variant="secondary" onClick={() => setView({ phase: "picker" })}>
              Välj ett och ett i stället
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onCancel}>
            Avbryt
          </Button>
        </form>
        <p className="text-xs text-ink-3 max-w-[68ch]">
          Google kan visa en varning om att appen inte är verifierad. Den gäller just den här läsrättigheten, som Google granskar
          extra noga.
        </p>
      </div>
    );
  }

  // The fallback: the Google Picker, one Doc at a time (the admin said no to read access).
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[68ch]">
        Välj föreningens gamla protokoll i Googles väljare. Ett dokument kan innehålla ett möte eller flera (ett per flik eller
        under var sin daterad rubrik). Simon Says läser dem i tidsordning och föreslår vilka mål ni jobbar mot nu, vilka ni
        har nått och vilka som har runnit ut i sanden.
      </p>
      <PrivacyNote />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={pick}>
          Välj protokoll …
        </Button>
        <Button variant="ghost" onClick={() => setView({ phase: "access" })}>
          Ge åtkomst till mapparna i stället
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </div>
    </div>
  );
}

const JOB_STATE: Record<Job["state"], string> = { waiting: "Väntar", reading: "Läser …", done: "Inläst", failed: "Gick inte" };

/** One row per meeting: waiting, reading, read or failed (with the server's reason). */
function Progress({ jobs }: { jobs: Job[] }) {
  const finished = jobs.filter((j) => j.state === "done" || j.state === "failed").length;
  const failed = jobs.filter((j) => j.state === "failed").length;
  const pct = jobs.length ? Math.round((finished / jobs.length) * 100) : 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-2" role="status" aria-live="polite">
        {finished < jobs.length ? (
          <>
            <Spinner className="align-[-0.125em]" /> Läser {Math.min(finished + 1, jobs.length)} av {jobs.length} protokoll … Låt sidan vara öppen.
          </>
        ) : (
          `Klart: ${plural(finished - failed, "protokoll", "protokoll")} inlästa.`
        )}
      </p>
      <div className="h-2 w-full max-w-[28rem] overflow-hidden rounded-full bg-sunk" aria-hidden>
        <div className="h-full rounded-full bg-ink-2 transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <ol className="max-h-[22rem] overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface" aria-label="Protokoll">
        {jobs.map((j) => (
          <li key={`${j.docId}-${j.section}`} className="flex items-start gap-3 border-t border-line px-3 py-2 first:border-t-0">
            <span className="mt-0.5 grid size-5 flex-none place-content-center" aria-hidden>
              {j.state === "reading" ? <Spinner /> : j.state === "done" ? <IconCheck size={16} strokeWidth={2.25} className="text-green" /> : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn("text-sm wrap-anywhere", j.state === "waiting" && "text-ink-3")}>{j.label}</span>
              {j.state === "failed" && j.message && <span className="text-xs text-ink-3">{j.message}</span>}
            </span>
            <span className={cn("flex-none text-xs", j.state === "done" ? "text-green" : j.state === "failed" ? "text-red" : "text-ink-3")}>{JOB_STATE[j.state]}</span>
          </li>
        ))}
      </ol>
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
