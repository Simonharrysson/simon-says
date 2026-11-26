"use client";

import { useState } from "react";
import { requestDriveAccess } from "@/app/(app)/orgs/drive-access";
import { PickerError, usePicker, type PickedFile } from "@/components/google/Picker";
import { Banner } from "@/components/ui/Banner";
import { Button, Spinner } from "@/components/ui/button";
import { IconGoogle } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { DriveFolder, ImportFile } from "@/lib/history/drive-list";
import { formatUsd, MAX_IMPORT_DOCS } from "@/lib/history/limits";
import { DIRECT_CONCURRENCY, type ImportMode, type JobProposal, type JobView } from "@/lib/history/progress";
import { plural } from "@/lib/format";
import { FileStep, FolderStep } from "./DriveSteps";
import { ImportProgress, type FinishedImport } from "./ImportProgress";

// "Läs in gamla protokoll" on the Översikt's goals card (todo #7): the admin gives Simon Says
// read access to their Drive once (incremental consent, drive.readonly, only here) → ticks the
// folders with the protocols → ticks the meetings in them (Simon Says' own Docs, templates and
// already imported ones are marked) → sees what it costs and that the TEXT goes to Claude →
// confirm → an import job (0036): up to 20 meetings read directly, a few at a time; more go to
// Claude in one batch at half price and the server carries on if the page closes
// (ImportProgress shows either from the database) → corrects dates that came from a file's
// creation date → goals (the caller asks for them, or opens the batch's stored proposal). An admin who says no to the read access can
// still pick Docs one by one in the Google Picker (the old flow).

/** What the page knows for the import: the admin's grant and the förening's meeting folder. */
export interface ImportAccess {
  /** Live read access for the import (google_import_tokens, under 24 h). */
  driveReadonly: boolean;
  /** The signed-in account, named when Google came back as another one. */
  email: string | null;
  meetingFolder: { id: string; name: string } | null;
}

export type EstimateDoc = { docId: string; sections: number } | { docId: string; error: string; message: string };

export interface ImportEstimate {
  docs: EstimateDoc[];
  protocols: number;
  /** Up to DIRECT_MAX meetings: read directly; more: one Anthropic batch at half price. */
  mode: ImportMode;
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
  | { phase: "access"; consent?: "nej" | "fel" | "konto" | "borttagen" }
  | { phase: "folders"; selected?: DriveFolder[]; subfolders?: boolean }
  | { phase: "files"; folders: DriveFolder[]; subfolders: boolean; initialFiles?: { files: ImportFile[]; truncated: boolean; folders: number } }
  /** The fallback without read access: the Google Picker, one Doc at a time. */
  | { phase: "picker" }
  | { phase: "estimating"; files: ImportDoc[]; back: Back }
  | { phase: "confirm"; files: ImportDoc[]; estimate: ImportEstimate; back: Back }
  /** An import job (0036): its progress, from the database. `autoRun`: just confirmed (direct reads now). */
  | { phase: "job"; job: JobView; autoRun?: boolean }
  | { phase: "starting"; protocols: number; mode: ImportMode }
  | { phase: "dates"; fileDated: FileDated[]; then: () => void }
  | { phase: "error"; message: string; back: Back };

/** A Doc to import: from the Picker, or from the folder browser with the listing's signed ticket. */
export interface ImportDoc {
  id: string;
  name: string;
  ticket?: string;
}

/** Where "Tillbaka" goes from the cost step. */
type Back = { phase: "files"; folders: DriveFolder[]; subfolders: boolean } | { phase: "picker" };

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
      i, och sparar inget annat från din Drive. Åtkomsten gäller i 24 timmar och tas sedan bort automatiskt; du kan också ta
      bort den direkt.
    </p>
  );
}

export function HistoryImport({
  orgId,
  access,
  consent,
  initial,
  demoNow,
  onDone,
  onProposal,
  onCancel,
}: {
  orgId: string;
  access: ImportAccess;
  /** Back from Google's consent screen. */
  consent?: "ok" | "nej" | "fel" | "konto";
  /** /design only. */
  initial?: ImportPhase;
  /** /design only: a fixed clock for the progress view (no requests). */
  demoNow?: number;
  onDone: (result: ImportResult) => void;
  /** A batch import's stored goals proposal (the cron ran the digest once). */
  onProposal: (proposal: JobProposal, notice: string) => void;
  onCancel: () => void;
}) {
  const picker = usePicker();
  const [view, setView] = useState<ImportPhase>(
    initial ?? (access.driveReadonly ? { phase: "folders" } : { phase: "access", ...(consent && consent !== "ok" ? { consent } : {}) }),
  );
  const needsAccess = () => setView({ phase: "access" });

  const estimate = async (files: ImportDoc[], back: Back) => {
    setView({ phase: "estimating", files, back });
    try {
      const res = await fetch(`/api/orgs/${orgId}/history/estimate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          docIds: files.map((f) => f.id),
          ...(files.every((f) => f.ticket) ? { tickets: Object.fromEntries(files.map((f) => [f.id, f.ticket])) } : {}),
        }),
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

  const run = async (files: ImportDoc[], e: ImportEstimate, back: Back) => {
    const docs = e.docs.flatMap((d) => {
      if (!("sections" in d)) return [];
      const file = files.find((f) => f.id === d.docId);
      return [{ docId: d.docId, name: file?.name ?? "Dokument", sections: d.sections }];
    });
    const picked = files.filter((f) => docs.some((d) => d.docId === f.id));
    setView({ phase: "starting", protocols: e.protocols, mode: e.mode });
    try {
      const res = await fetch(`/api/orgs/${orgId}/history/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          docs,
          ...(picked.length && picked.every((f) => f.ticket) ? { tickets: Object.fromEntries(picked.map((f) => [f.id, f.ticket])) } : {}),
        }),
      });
      const json = (await res.json().catch(() => null)) as { job?: JobView; message?: string } | null;
      if (!res.ok || !json?.job) {
        setView({ phase: "error", message: json?.message ?? "Inläsningen kunde inte startas. Försök igen.", back });
        return;
      }
      setView({ phase: "job", job: json.job, autoRun: true });
    } catch {
      setView({ phase: "error", message: "Vi nådde inte servern. Kontrollera nätet och försök igen.", back });
    }
  };

  /** Dates from a file's creation date are checked first, then the goals. */
  const afterImport = (r: FinishedImport, next: () => void) => {
    if (r.fileDated.length) setView({ phase: "dates", fileDated: r.fileDated, then: next });
    else next();
  };
  const summary = (r: FinishedImport) =>
    [r.imported ? `${plural(r.imported, "protokoll", "protokoll")} inlästa.` : "", r.failed ? `${plural(r.failed, "protokoll", "protokoll")} gick inte att läsa.` : ""]
      .filter(Boolean)
      .join(" ");

  if (view.phase === "dates") return <FileDates orgId={orgId} items={view.fileDated} onDone={view.then} />;
  if (view.phase === "job") {
    return (
      <ImportProgress
        key={view.job.id}
        orgId={orgId}
        initial={view.job}
        autoRun={view.autoRun}
        now={demoNow}
        onFinished={(r) => afterImport(r, () => onDone({ imported: r.imported, failed: r.failed, stopped: r.stopped }))}
        onProposal={(proposal, r) => afterImport(r, () => onProposal(proposal, summary(r)))}
        onClose={onCancel}
      />
    );
  }
  if (view.phase === "starting") {
    return (
      <p className="text-sm text-ink-3" role="status" aria-live="polite">
        <Spinner className="align-[-0.125em]" />{" "}
        {view.mode === "batch"
          ? `Simon Says öppnar ${plural(view.protocols, "protokoll", "protokoll")} och skickar dem till Claude i en omgång … Det tar upp till en minut.`
          : "Startar inläsningen …"}
      </p>
    );
  }

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
        onRemoved={() => setView({ phase: "access", consent: "borttagen" })}
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
        onNext={(files) => estimate(files.map((f) => ({ id: f.id, name: f.name, ...(f.ticket ? { ticket: f.ticket } : {}) })), back)}
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
        {e.mode === "batch" ? (
          <p className="text-sm text-ink-2 max-w-[68ch]">
            Så många protokoll skickas till Claude <strong>i en omgång</strong>, till halva priset. De flesta omgångar är klara
            inom en timme, alla inom ett dygn. Du kan stänga sidan under tiden; resultatet och förslaget på mål väntar här.
          </p>
        ) : (
          <p className="text-sm text-ink-2 max-w-[68ch]">
            Simon Says läser {Math.min(DIRECT_CONCURRENCY, e.protocols)} protokoll åt gången, ungefär en halv minut vardera. Låt sidan vara öppen tills det är klart.
          </p>
        )}
        <p className="text-sm text-ink-3">
          Kostnad för Simon Says: {formatUsd(e.totalUsd)} (läsa protokollen {formatUsd(e.importUsd)}
          {e.mode === "batch" ? ", halva priset" : ""}, förslag på mål över hela historiken {formatUsd(e.digestUsd)}).
          Sedan föreslår Simon Says mål, och du godkänner dem innan någon annan ser dem.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={e.protocols === 0} onClick={() => run(view.files, e, view.back)}>
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
        ) : view.consent === "konto" ? (
          <Banner tone="warning" title="Fel Google-konto" live={false}>
            {access.email ? `Välj samma Google-konto som du är inloggad med: ${access.email}.` : "Välj samma Google-konto som du är inloggad med."}{" "}
            Inget sparades.
          </Banner>
        ) : view.consent === "borttagen" ? (
          <Banner tone="success" live={false}>
            Läsåtkomsten är borttagen hos Simon Says. Dina inlästa protokoll ligger kvar.
          </Banner>
        ) : null}
        <DriveAccessNote />
        <form action={requestDriveAccess} className="flex flex-wrap gap-2">
          <input type="hidden" name="orgId" value={orgId} />
          <SubmitButton variant="primary" icon={<IconGoogle size={16} />} pendingLabel="Öppnar Google …">
            Ge åtkomst
          </SubmitButton>
          {(view.consent === "nej" || view.consent === "borttagen") && (
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
