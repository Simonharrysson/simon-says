"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PickerError, usePicker } from "@/components/google/Picker";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/Field";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { FormatKind } from "@/lib/formats/schema";
import { meetingTypeName, type PreparedSuggestion } from "@/lib/prepare/types";

// The start screen's agenda step (A11): which Doc the meeting runs in. Doc names are the
// förening's own text: shown, never logged. Start stays disabled until the choice is confirmed
// (Använd, a Picker pick, or "Skapa nytt dokument"); a suggestion is never used on its own.
// An agenda Simon Says prepared (Förbered möte) is suggested first: no Picker needed, and it runs
// in the format it was prepared in.

export interface AgendaFormatOption {
  /** A format_profiles row; null: a standard format by `kind` (or the org's Enkel default without a row). */
  id: string | null;
  kind: FormatKind;
  name: string;
  isDefault: boolean;
}

export interface AgendaChoice {
  agendaDocId: string | null;
  agendaName: string | null;
  formatProfileId: string | null;
  formatKind: string | null;
  transcriptInDoc: boolean;
  confirmed: boolean;
  /** A new Doc in a format: the goals ticked under "Mål att ta upp" (todo #12). */
  goalIds?: string[];
}

/** "Mål att ta upp" on the start screen (todo #12): a goal Simon Says suggests, with why. */
export interface GoalOption {
  id: string;
  /** "Mål: <titel>", as it would stand in the Doc. */
  label: string;
  /** Shown here only, never in the Doc. */
  reason: string;
}

export type AgendaViewState =
  | { state: "loading" }
  | { state: "suggestion"; suggestion: { id: string; name: string } }
  | { state: "prepared"; prepared: PreparedSuggestion }
  | { state: "none" }
  | { state: "folder-unreachable"; folderName?: string | null }
  | { state: "picker-off" };

/**
 * The start's `warnings` (C2): required items (stadgar) the agenda Doc lacks, as the page says
 * them. Null when nothing is missing. Simon Says never adds the items to a human's agenda.
 */
export function missingItemsText(warnings: string[] | null | undefined): string | null {
  const items = (warnings ?? []).map((w) => w.trim()).filter(Boolean);
  return items.length ? `Dagordningen saknar: ${items.join(", ")}. Simon Says lägger inte till punkter i ert dokument.` : null;
}

const optionValue = (f: AgendaFormatOption) => (f.id ? `id:${f.id}` : `kind:${f.kind}`);
const defaultValue = (formats: AgendaFormatOption[]) => {
  const def = formats.find((f) => f.isDefault) ?? formats[0];
  return def ? optionValue(def) : "";
};

/** The select value for a kept override; the default when there is none (or it is gone). */
function initialValue(
  formats: AgendaFormatOption[],
  keep: Pick<AgendaChoice, "formatProfileId" | "formatKind"> | null,
): string {
  const f = keep?.formatProfileId
    ? formats.find((o) => o.id === keep.formatProfileId)
    : keep?.formatKind
      ? formats.find((o) => !o.id && o.kind === keep.formatKind)
      : undefined;
  return f ? optionValue(f) : defaultValue(formats);
}

/** The start body's format fields for a select value: nothing for the default (the server reads it). */
function formatFields(formats: AgendaFormatOption[], value: string): Pick<AgendaChoice, "formatProfileId" | "formatKind"> {
  const f = formats.find((o) => optionValue(o) === value);
  if (!f || f.isDefault) return { formatProfileId: null, formatKind: null };
  return f.id ? { formatProfileId: f.id, formatKind: null } : { formatProfileId: null, formatKind: f.kind };
}

export interface AgendaStepViewProps {
  view: AgendaViewState;
  formats: AgendaFormatOption[];
  formatValue: string;
  /** The confirmed choice: an agenda Doc (`prepared`: the one Simon Says prepared), a new Doc, or nothing yet. */
  chosen: { kind: "agenda"; name: string; prepared?: { date: string; kind: PreparedSuggestion["kind"] } } | { kind: "new" } | null;
  /** Offer the "Transkript" tab checkbox (the förening shares transcripts). */
  offerTranscript: boolean;
  transcriptInDoc: boolean;
  /** A Picker or request is in flight. */
  busy?: boolean;
  /** A short Swedish status/problem line (announced politely). */
  message?: string | null;
  disabled?: boolean;
  onUseSuggestion: () => void;
  /** The prepared agenda: use it (its starter's grant can edit it) or open it once in the Picker. */
  onUsePrepared?: () => void;
  onPickDoc: () => void;
  onUseFolder: () => void;
  onNewDoc: () => void;
  onFormatChange: (value: string) => void;
  onTranscriptChange: (on: boolean) => void;
  /** Focus the confirmed choice on mount (after "Skapa nytt dokument i stället", whose button is gone). */
  focusChoiceOnMount?: boolean;
  /** A new Doc in a format: the goals to offer, and the ticked ones. */
  goals?: GoalOption[];
  goalIds?: string[];
  onGoalChange?: (id: string, on: boolean) => void;
}

/** What the polite live region says for a state (the visible line may be richer). */
function announcement(p: AgendaStepViewProps, formatName: string): string {
  if (p.message) return p.message;
  if (p.chosen?.kind === "agenda") return `Dagordning vald: ${p.chosen.name}.`;
  if (p.chosen?.kind === "new") return `Nytt dokument i formatet ${formatName}.`;
  switch (p.view.state) {
    case "suggestion":
      return `Förslag: ${p.view.suggestion.name}.`;
    case "prepared":
      return `Förberedd dagordning för ${preparedDay(p.view.prepared.date)}.`;
    case "none":
      return "Ingen dagordning hittades.";
    case "folder-unreachable":
      return p.view.folderName
        ? `Ditt Google-konto har inte öppnat mötesmappen ${p.view.folderName} än.`
        : "Ditt Google-konto har inte öppnat mötesmappen än.";
    default:
      return "";
  }
}

const preparedDay = (date: string) =>
  new Intl.DateTimeFormat("sv-SE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Stockholm" }).format(new Date(`${date}T12:00:00Z`));

/** Presentational: no fetching (the /design page renders every state with fake data). */
export function AgendaStepView(p: AgendaStepViewProps) {
  const id = useId();
  const formatName = p.formats.find((f) => optionValue(f) === p.formatValue)?.name ?? "";
  const formatKind = p.formats.find((f) => optionValue(f) === p.formatValue)?.kind;
  const off = p.view.state === "picker-off";
  const lock = p.busy || p.disabled;

  // A confirm (Använd, a pick, Skapa nytt) unmounts the button that had focus: move focus to
  // the confirmed line instead of letting it fall to <body>. Not on mount (unless asked).
  const choiceRef = useRef<HTMLParagraphElement>(null);
  const mounted = useRef(false);
  const chosenKey = p.chosen ? (p.chosen.kind === "agenda" ? `agenda:${p.chosen.name}` : "new") : "";
  const focusOnMount = p.focusChoiceOnMount ?? false;
  useEffect(() => {
    if (mounted.current || focusOnMount) {
      if (chosenKey) choiceRef.current?.focus();
    }
    mounted.current = true;
  }, [chosenKey, focusOnMount]);

  let body: ReactNode;
  if (p.chosen?.kind === "agenda") {
    body = (
      <>
        <p className="flex items-baseline gap-2" ref={choiceRef} tabIndex={-1}>
          <span>
            Dagordning: <strong className="wrap-anywhere">{p.chosen.name}</strong>
          </span>
        </p>
        {p.chosen.prepared && (
          <p className="-mt-2 text-xs text-ink-3">
            Förberedd för {preparedDay(p.chosen.prepared.date)} · {meetingTypeName(p.chosen.prepared.kind)}. Förra veckans uppgifter står redan under
            Från förra veckan.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {!off && (
            <Button size="sm" variant="ghost" onClick={p.onPickDoc} disabled={lock}>
              Välj annan
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={p.onNewDoc} disabled={lock}>
            Skapa nytt dokument
          </Button>
        </div>
      </>
    );
  } else if (p.chosen?.kind === "new") {
    body = (
      <>
        <p className="flex items-baseline gap-2" ref={choiceRef} tabIndex={-1}>
          <span>
            Nytt dokument i formatet <strong>{formatName}</strong>
          </span>
        </p>
        {off ? (
          <p className="text-xs text-ink-3">Google-väljaren är inte inställd än.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="ghost" onClick={p.onPickDoc} disabled={lock}>
              Välj dagordning
            </Button>
          </div>
        )}
      </>
    );
  } else if (p.view.state === "loading") {
    body = <p className="flex items-baseline gap-2 text-ink-2">Letar efter dagens dagordning…</p>;
  } else if (p.view.state === "prepared") {
    const prep = p.view.prepared;
    body = (
      <>
        <p className="flex flex-col gap-1">
          <span>
            Starta med dagordningen från <strong className="font-medium">{preparedDay(prep.date)}</strong>
            {prep.time ? ` kl. ${prep.time.replace(":", ".")}` : ""}
          </span>
          <span className="text-xs text-ink-3 wrap-anywhere">
            {meetingTypeName(prep.kind)} · {prep.name}
          </span>
        </p>
        {!prep.accessible && (
          <p className="text-xs text-ink-3">
            Den förbereddes med ett annat Google-konto. Öppna den en gång i Google-väljaren, så kan Simon Says skriva i den.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" onClick={prep.accessible ? p.onUsePrepared : p.onPickDoc} disabled={lock}>
            {prep.accessible ? "Använd" : "Öppna i Google-väljaren"}
          </Button>
          {prep.accessible && (
            <Button size="sm" variant="ghost" onClick={p.onPickDoc} disabled={lock || off}>
              Välj annan
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={p.onNewDoc} disabled={lock}>
            Skapa nytt dokument
          </Button>
        </div>
      </>
    );
  } else if (p.view.state === "suggestion") {
    body = (
      <>
        <p className="flex items-baseline gap-2">
          <span>
            Förslag: <strong className="wrap-anywhere">{p.view.suggestion.name}</strong>
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" onClick={p.onUseSuggestion} disabled={lock}>
            Använd
          </Button>
          <Button size="sm" variant="ghost" onClick={p.onPickDoc} disabled={lock}>
            Välj annan
          </Button>
          <Button size="sm" variant="ghost" onClick={p.onNewDoc} disabled={lock}>
            Skapa nytt dokument
          </Button>
        </div>
      </>
    );
  } else if (p.view.state === "folder-unreachable") {
    body = (
      <>
        <p className="flex items-baseline gap-2">
          {p.view.folderName ? (
            <span>
              Föreningens mötesmapp heter <strong className="font-medium">{p.view.folderName}</strong>. Ditt Google-konto har inte
              öppnat den än. Välj den en gång i Google-väljaren, så hamnar mötesdokumentet där.
            </span>
          ) : (
            <span>
              Föreningen har en mötesmapp, men ditt Google-konto har inte öppnat den än. Välj den en gång i Google-väljaren, så
              hamnar mötesdokumentet där.
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" onClick={p.onUseFolder} disabled={lock}>
            Använd mötesmappen
          </Button>
          <Button size="sm" variant="ghost" onClick={p.onPickDoc} disabled={lock}>
            Välj dagordning
          </Button>
          <Button size="sm" variant="ghost" onClick={p.onNewDoc} disabled={lock}>
            Skapa nytt dokument
          </Button>
        </div>
      </>
    );
  } else {
    // "none" (and picker-off before the fallback is set, which the container never shows)
    body = (
      <>
        <p className="flex items-baseline gap-2">Ingen dagordning – skapa nytt dokument i formatet {formatName}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" onClick={p.onNewDoc} disabled={lock}>
            Skapa nytt dokument
          </Button>
          {!off && (
            <Button size="sm" variant="ghost" onClick={p.onPickDoc} disabled={lock}>
              Välj dagordning
            </Button>
          )}
        </div>
      </>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-4" aria-labelledby={`${id}-title`} aria-busy={p.busy || undefined}>
      <h2 id={`${id}-title`} className="text-lg">
        Dagordning
      </h2>
      <div className="flex flex-col gap-3">{body}</div>
      {p.message && <p className="text-xs text-ink-3">{p.message}</p>}
      <span className="sr-only" aria-live="polite">
        {announcement(p, formatName)}
      </span>

      {p.chosen?.kind === "agenda" && p.offerTranscript && (
        <Check
          id={`${id}-transcript`}
          title="Lägg transkriptet i dokumentet?"
          checked={p.transcriptInDoc}
          onCheckedChange={(on) => p.onTranscriptChange(on === true)}
          disabled={p.disabled}
        />
      )}

      {p.chosen?.kind === "new" && formatKind !== "enkel" && (p.goals?.length ?? 0) > 0 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 font-medium">Mål att ta upp</legend>
          {p.goals!.map((g) => (
            <Check
              key={g.id}
              id={`${id}-goal-${g.id}`}
              title={g.label}
              checked={p.goalIds?.includes(g.id) ?? false}
              onCheckedChange={(on) => p.onGoalChange?.(g.id, on === true)}
              disabled={p.disabled}
            >
              {g.reason}
            </Check>
          ))}
        </fieldset>
      )}

      {p.formats.length > 1 && !(p.chosen?.kind === "agenda" && p.chosen.prepared) && !(p.chosen === null && p.view.state === "prepared") && (
        <div className="flex max-w-[22rem] flex-col gap-1">
          <Label htmlFor={`${id}-format`}>Format</Label>
          <NativeSelect
            id={`${id}-format`}
            value={p.formatValue}
            onChange={(e) => p.onFormatChange(e.target.value)}
            disabled={p.disabled}
          >
            {p.formats.map((f) => (
              <option key={optionValue(f)} value={optionValue(f)}>
                {f.name}
                {f.isDefault ? " (förvalt)" : ""}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
    </section>
  );
}

export interface AgendaStepProps {
  orgId: string;
  formats: AgendaFormatOption[];
  pickerEnabled: boolean;
  onChange(choice: AgendaChoice): void;
  /** The förening shares transcripts: only then is "Lägg transkriptet i dokumentet?" offered. */
  shareTranscript?: boolean;
  /** Start on "new Doc", confirmed (after an agenda_* start error: "Skapa nytt dokument i stället"). Remount by key to apply. */
  startWithNewDoc?: boolean;
  /** Pre-select this format override (kept across the remount after an agenda_* error). */
  initialFormat?: Pick<AgendaChoice, "formatProfileId" | "formatKind"> | null;
  disabled?: boolean;
  /** "Mål att ta upp" (todo #12): offered under a new Doc in a format, unticked. */
  goals?: GoalOption[];
}

/** The container: reads the candidates, opens the Picker, reports the choice through `onChange`. */
export function AgendaStep(props: AgendaStepProps) {
  return props.pickerEnabled ? <AgendaStepOn {...props} /> : <AgendaStepOff {...props} />;
}

/**
 * No Picker configured: the fallback, as before A11 (a new Doc), confirmed from the start. Only
 * an agenda Simon Says prepared (Förbered möte) and this starter can edit is offered first: it
 * needs no Picker.
 */
/** The ticked goals, as toggled by the view. */
function useGoalTicks() {
  const [goalIds, setGoalIds] = useState<string[]>([]);
  const onGoalChange = useCallback((id: string, on: boolean) => setGoalIds((ids) => (on ? [...ids.filter((x) => x !== id), id] : ids.filter((x) => x !== id))), []);
  return { goalIds, onGoalChange };
}

function AgendaStepOff({ orgId, formats, onChange, disabled, initialFormat = null, startWithNewDoc = false, goals }: AgendaStepProps) {
  const [formatValue, setFormatValue] = useState(() => initialValue(formats, initialFormat));
  const { goalIds, onGoalChange } = useGoalTicks();
  const [prepared, setPrepared] = useState<PreparedSuggestion | null>(null);
  const [chosen, setChosen] = useState<AgendaStepViewProps["chosen"]>({ kind: "new" });
  useEffect(() => {
    if (startWithNewDoc) return;
    let live = true;
    fetch(`/api/orgs/${orgId}/agenda-candidates`, { cache: "no-store", signal: AbortSignal.timeout(CANDIDATES_TIMEOUT_MS) })
      .then((res) => (res.ok ? (res.json() as Promise<Candidates>) : null))
      .then((json) => {
        if (!live || !json?.prepared?.accessible) return;
        setPrepared(json.prepared);
        setChosen(null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [orgId, startWithNewDoc]);
  useEffect(() => {
    const usePrep = chosen?.kind === "agenda" && prepared;
    onChange({
      agendaDocId: usePrep ? prepared.docId : null,
      agendaName: usePrep ? chosen.name : null,
      ...(usePrep ? { formatProfileId: null, formatKind: null } : formatFields(formats, formatValue)),
      transcriptInDoc: false,
      confirmed: chosen !== null,
      goalIds: chosen?.kind === "new" ? goalIds : [],
    });
  }, [formats, formatValue, onChange, chosen, prepared, goalIds]);
  return (
    <AgendaStepView
      view={prepared && chosen === null ? { state: "prepared", prepared } : { state: "picker-off" }}
      formats={formats}
      formatValue={formatValue}
      chosen={chosen}
      offerTranscript={false}
      transcriptInDoc={false}
      disabled={disabled}
      onUseSuggestion={() => {}}
      onUsePrepared={() => prepared && setChosen({ kind: "agenda", name: prepared.name, prepared: { date: prepared.date, kind: prepared.kind } })}
      onPickDoc={() => {}}
      onUseFolder={() => {}}
      onNewDoc={() => setChosen({ kind: "new" })}
      onFormatChange={setFormatValue}
      onTranscriptChange={() => {}}
      goals={goals}
      goalIds={goalIds}
      onGoalChange={onGoalChange}
    />
  );
}

/** GET agenda-candidates must answer within this long, or the step offers "Skapa nytt dokument". */
const CANDIDATES_TIMEOUT_MS = 15_000;

interface Candidates {
  folderId: string | null;
  folderName?: string | null;
  accessible: boolean;
  candidates: { id: string; name: string }[];
  suggestedId: string | null;
  prepared?: PreparedSuggestion | null;
}

function AgendaStepOn({
  orgId,
  formats,
  onChange,
  shareTranscript = false,
  startWithNewDoc = false,
  initialFormat = null,
  disabled,
  goals,
}: AgendaStepProps) {
  const picker = usePicker();
  const { goalIds, onGoalChange } = useGoalTicks();
  const [view, setView] = useState<AgendaViewState>({ state: "loading" });
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [chosen, setChosen] = useState<AgendaStepViewProps["chosen"]>(startWithNewDoc ? { kind: "new" } : null);
  const [agendaDocId, setAgendaDocId] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedSuggestion | null>(null);
  const [formatValue, setFormatValue] = useState(() => initialValue(formats, initialFormat));
  const [transcriptInDoc, setTranscriptInDoc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setView({ state: "loading" });
    try {
      // A stalled Google call must not block Start: after the timeout the step falls back to "none".
      const res = await fetch(`/api/orgs/${orgId}/agenda-candidates`, { cache: "no-store", signal: AbortSignal.timeout(CANDIDATES_TIMEOUT_MS) });
      const json = (await res.json().catch(() => null)) as (Candidates & { message?: string }) | null;
      if (seq !== loadSeq.current) return;
      if (!res.ok || !json) {
        setView({ state: "none" });
        setMessage(json?.message ?? "Vi kunde inte läsa mötesmappen just nu.");
        return;
      }
      setFolderId(json.folderId);
      setFolderName(json.folderName ?? null);
      const suggestion = json.candidates.find((c) => c.id === json.suggestedId);
      setPrepared(json.prepared ?? null);
      if (json.prepared) setView({ state: "prepared", prepared: json.prepared });
      else if (json.folderId && !json.accessible) setView({ state: "folder-unreachable", folderName: json.folderName ?? null });
      else if (suggestion) setView({ state: "suggestion", suggestion: { id: suggestion.id, name: suggestion.name } });
      else setView({ state: "none" });
    } catch {
      if (seq !== loadSeq.current) return;
      setView({ state: "none" });
      setMessage("Vi kunde inte läsa mötesmappen just nu.");
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onChange({
      agendaDocId: chosen?.kind === "agenda" ? agendaDocId : null,
      agendaName: chosen?.kind === "agenda" ? chosen.name : null,
      // A prepared agenda runs in the format it was prepared in (the server reads it).
      ...(chosen?.kind === "agenda" && chosen.prepared ? { formatProfileId: null, formatKind: null } : formatFields(formats, formatValue)),
      transcriptInDoc: chosen?.kind === "agenda" && shareTranscript ? transcriptInDoc : false,
      confirmed: chosen !== null,
      goalIds: chosen?.kind === "new" ? goalIds : [],
    });
  }, [chosen, agendaDocId, formats, formatValue, transcriptInDoc, shareTranscript, onChange, goalIds]);

  const chooseDoc = (doc: { id: string; name: string }) => {
    setAgendaDocId(doc.id);
    const prep = prepared && prepared.docId === doc.id ? { date: prepared.date, kind: prepared.kind } : undefined;
    setChosen({ kind: "agenda", name: doc.name || prepared?.name || "Valt dokument", ...(prep ? { prepared: prep } : {}) });
    setMessage(null);
  };

  const pickerFailed = (err: unknown) =>
    setMessage(err instanceof PickerError ? err.message : "Google-väljaren kunde inte öppnas. Försök igen.");

  const onPickDoc = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const picked = await picker.open({ mode: "doc", parentId: folderId ?? undefined, title: "Välj dagordning" });
      if (picked?.[0]) chooseDoc(picked[0]);
    } catch (err) {
      pickerFailed(err);
    } finally {
      setBusy(false);
    }
  };

  const onUseFolder = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const picked = await picker.open({ mode: "folder", title: folderName ? `Välj mötesmappen ”${folderName}”` : "Välj mötesmappen" });
      if (!picked?.[0]) return;
      const res = await fetch(`/api/orgs/${orgId}/meeting-folder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // grantOnly: the start screen never changes the förening's folder (only FormatCard does).
        body: JSON.stringify({ folderId: picked[0].id, grantOnly: true }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { message?: string } | null;
        setMessage(json?.message ?? "Mötesmappen kunde inte sparas. Försök igen.");
        return;
      }
      await load();
    } catch (err) {
      pickerFailed(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AgendaStepView
      view={view}
      formats={formats}
      formatValue={formatValue}
      chosen={chosen}
      offerTranscript={shareTranscript}
      transcriptInDoc={transcriptInDoc}
      busy={busy}
      message={message}
      disabled={disabled}
      onUseSuggestion={() => view.state === "suggestion" && chooseDoc(view.suggestion)}
      onUsePrepared={() => view.state === "prepared" && chooseDoc({ id: view.prepared.docId, name: view.prepared.name })}
      onPickDoc={() => void onPickDoc()}
      onUseFolder={() => void onUseFolder()}
      onNewDoc={() => {
        setChosen({ kind: "new" });
        setAgendaDocId(null);
        setMessage(null);
      }}
      onFormatChange={setFormatValue}
      onTranscriptChange={setTranscriptInDoc}
      focusChoiceOnMount={startWithNewDoc}
      goals={goals}
      goalIds={goalIds}
      onGoalChange={onGoalChange}
    />
  );
}
