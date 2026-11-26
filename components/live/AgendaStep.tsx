"use client";

import { useLocale, useTranslations } from "next-intl";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PickerError, usePicker } from "@/components/google/Picker";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/Field";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { FormatKind } from "@/lib/formats/schema";
import type { PreparedSuggestion } from "@/lib/prepare/types";
import { defaultLocale, intlTag, type Locale } from "@/lib/i18n/config";
import { translator } from "@/lib/i18n/translator";
import { autoPickPrepared } from "@/lib/prepare/auto-pick";
import { IconChevronDown } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

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
export function missingItemsText(warnings: string[] | null | undefined, locale: Locale = defaultLocale): string | null {
  const items = (warnings ?? []).map((w) => w.trim()).filter(Boolean);
  return items.length ? translator(locale)("live.agenda.missing", { items: items.join(", ") }) : null;
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
  /**
   * The choice: an agenda Doc (`prepared`: the one Simon Says prepared), a new Doc, or nothing yet.
   * `auto`: picked by the start screen itself (today's prepared agenda), not by the user: no focus move.
   */
  chosen:
    | { kind: "agenda"; name: string; prepared?: { date: string; kind: PreparedSuggestion["kind"] }; auto?: boolean }
    | { kind: "new" }
    | null;
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
  /** The förening's meeting folder is reachable with this starter's grant: a new Doc lands there. */
  inFolder?: boolean;
  /** Started from a calendar event (todo #14): its title, the meeting's name on the line. */
  eventTitle?: string | null;
  /** /design: render the "Byt" panel open. */
  panelOpen?: boolean;
  /** No Google Picker configured (the view may still offer a prepared agenda). */
  pickerOff?: boolean;
}

/** What the polite live region says for a state (the visible line may be richer). */
function announcement(p: AgendaStepViewProps, formatName: string, locale: Locale): string {
  const t = translator(locale);
  if (p.message) return p.message;
  if (p.chosen?.kind === "agenda") return t("live.agenda.chosenAnnounce", { name: p.chosen.name });
  switch (p.view.state) {
    case "suggestion":
      return t("live.agenda.suggestionAnnounce", { name: p.view.suggestion.name });
    case "prepared":
      return t("live.agenda.preparedAnnounce", { date: preparedDay(p.view.prepared.date, locale) });
    case "folder-unreachable":
      return p.view.folderName
        ? t("live.agenda.folderNamedAnnounce", { folder: p.view.folderName })
        : t("live.agenda.folderAnnounce");
  }
  if (p.chosen?.kind === "new") return t("live.agenda.newAnnounce", { format: formatName });
  return p.view.state === "none" ? t("live.agenda.noneAnnounce") : "";
}

const preparedDay = (date: string, locale: Locale) =>
  new Intl.DateTimeFormat(intlTag(locale), { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Stockholm" }).format(new Date(`${date}T12:00:00Z`));

/**
 * Presentational: no fetching (the /design page renders every state with fake data). One line
 * says which meeting it will be (a new Doc until something better is known; it updates in place),
 * with a quiet offer under it (today's agenda, a suggestion, the folder) and "Byt", which opens
 * every other choice: the Picker, a new Doc, the transcript tab, goals and the format.
 */
export function AgendaStepView(p: AgendaStepViewProps) {
  const t = useTranslations("live.agenda");
  const types = useTranslations("formats.meetingTypes");
  const tCal = useTranslations("calendar");
  const locale = useLocale();
  const strong = (chunks: ReactNode) => <strong className="wrap-anywhere">{chunks}</strong>;
  const id = useId();
  const formatName = p.formats.find((f) => optionValue(f) === p.formatValue)?.name ?? "";
  const formatKind = p.formats.find((f) => optionValue(f) === p.formatValue)?.kind;
  const off = p.pickerOff === true || p.view.state === "picker-off";
  const lock = p.busy || p.disabled;
  const [open, setOpen] = useState(p.panelOpen ?? false);

  // A confirm (Använd, a pick, Skapa nytt) unmounts the button that had focus: move focus to
  // the line instead of letting it fall to <body>, and fold the panel. Not on mount (unless
  // asked), and not when the start screen picked today's agenda by itself.
  const choiceRef = useRef<HTMLParagraphElement>(null);
  const chosenKey = p.chosen ? (p.chosen.kind === "agenda" ? `agenda:${p.chosen.name}` : "new") : "";
  const auto = p.chosen?.kind === "agenda" && p.chosen.auto === true;
  // The key last acted on (a previous-key ref, not a mounted flag: dev runs effects twice on mount).
  const prevKey = useRef<string | null>(p.focusChoiceOnMount ? null : chosenKey);
  useEffect(() => {
    if (prevKey.current === chosenKey) return;
    prevKey.current = chosenKey;
    if (!chosenKey || auto) return;
    setOpen(false);
    choiceRef.current?.focus();
  }, [chosenKey, auto]);

  const chosenPrepared = p.chosen?.kind === "agenda" && Boolean(p.chosen.prepared);
  const newLine = (p.inFolder ? t.rich("newInFolder", { format: formatName, strong }) : t.rich("newIn", { format: formatName, strong }));
  const line =
    p.chosen?.kind === "agenda" ? t.rich("chosen", { name: p.chosen.name, strong }) : p.chosen?.kind === "new" ? newLine : p.view.state === "loading" ? t("loading") : t("none", { format: formatName });

  // The quiet offer under the line: one tap, never used on its own (A11), except today's agenda.
  let offer: ReactNode = null;
  if (p.view.state === "loading" && p.chosen?.kind !== "agenda") {
    offer = <p className="text-ink-3">{t("looking")}</p>;
  } else if (p.view.state === "prepared" && !chosenPrepared) {
    const prep = p.view.prepared;
    offer = (
      <>
        <p>
          {t.rich("startWith", {
            date: preparedDay(prep.date, locale),
            time: prep.time ? t("atTime", { time: locale === "en" ? prep.time : prep.time.replace(":", ".") }) : "",
            strong: (chunks) => <strong className="font-medium">{chunks}</strong>,
          })}
          <span className="block text-xs text-ink-3 wrap-anywhere">
            {types(`${prep.kind}.name`)} · {prep.name}
          </span>
        </p>
        {!prep.accessible && <p className="text-xs text-ink-3">{t("otherAccount")}</p>}
        <Button size="sm" variant="secondary" className="self-start" onClick={prep.accessible ? p.onUsePrepared : p.onPickDoc} disabled={lock || (!prep.accessible && off)}>
          {prep.accessible ? t("use") : t("openInPicker")}
        </Button>
      </>
    );
  } else if (p.view.state === "suggestion" && !(p.chosen?.kind === "agenda" && p.chosen.name === p.view.suggestion.name)) {
    offer = (
      <>
        <p>{t.rich("suggestion", { name: p.view.suggestion.name, strong })}</p>
        <Button size="sm" variant="secondary" className="self-start" onClick={p.onUseSuggestion} disabled={lock}>
          {t("use")}
        </Button>
      </>
    );
  } else if (p.view.state === "folder-unreachable" && p.chosen?.kind !== "agenda") {
    offer = (
      <>
        <p>
          {p.view.folderName ? t.rich("folderNamed", { folder: p.view.folderName, strong: (chunks) => <strong className="font-medium">{chunks}</strong> }) : t("folder")}
        </p>
        <Button size="sm" variant="secondary" className="self-start" onClick={p.onUseFolder} disabled={lock}>
          {t("useFolder")}
        </Button>
      </>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-4" aria-labelledby={`${id}-title`} aria-busy={p.busy || undefined}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`${id}-title`} className="text-sm font-semibold text-ink-2">
            {t("lineTitle")}
          </h2>
          {p.eventTitle && <p className="font-medium wrap-anywhere">{tCal("fromCalendar", { title: p.eventTitle })}</p>}
          <p ref={choiceRef} tabIndex={-1} className="rounded-sm">
            {line}
          </p>
          {p.chosen?.kind === "agenda" && p.chosen.prepared && (
            <p className="text-xs text-ink-3">
              {t("preparedFor", { date: preparedDay(p.chosen.prepared.date, locale), type: types(`${p.chosen.prepared.kind}.name`) })}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          aria-label={t("changeLabel")}
          onClick={() => setOpen((o) => !o)}
        >
          {t("change")}
          <IconChevronDown size={16} aria-hidden="true" className={cn("transition-transform duration-120", open && "rotate-180")} />
        </Button>
      </div>

      {offer && <div className="flex flex-col gap-2 border-t border-line pt-3 text-sm">{offer}</div>}
      {p.message && <p className="text-xs text-ink-3">{p.message}</p>}
      <span className="sr-only" aria-live="polite">
        {announcement(p, formatName, locale)}
      </span>

      <div id={`${id}-panel`} hidden={!open} className="flex flex-col gap-4 border-t border-line pt-3">
        {open && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              {!off && (
                <Button size="sm" variant="secondary" onClick={p.onPickDoc} disabled={lock}>
                  {p.chosen?.kind === "agenda" ? t("pickOther") : t("pick")}
                </Button>
              )}
              {p.chosen?.kind !== "new" && (
                <Button size="sm" variant="ghost" onClick={p.onNewDoc} disabled={lock}>
                  {t("newDoc")}
                </Button>
              )}
            </div>
            {off && <p className="text-xs text-ink-3">{t("pickerOff")}</p>}

            {p.chosen?.kind === "agenda" && p.offerTranscript && (
              <Check
                id={`${id}-transcript`}
                title={t("transcript")}
                checked={p.transcriptInDoc}
                onCheckedChange={(on) => p.onTranscriptChange(on === true)}
                disabled={p.disabled}
              />
            )}

            {p.chosen?.kind === "new" && formatKind !== "enkel" && (p.goals?.length ?? 0) > 0 && (
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-1 font-medium">{t("goalsTitle")}</legend>
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

            {p.formats.length > 1 && !chosenPrepared && (
              <div className="flex max-w-[22rem] flex-col gap-1">
                <Label htmlFor={`${id}-format`}>{t("format")}</Label>
                <NativeSelect
                  id={`${id}-format`}
                  value={p.formatValue}
                  onChange={(e) => p.onFormatChange(e.target.value)}
                  disabled={p.disabled}
                >
                  {p.formats.map((f) => (
                    <option key={optionValue(f)} value={optionValue(f)}>
                      {f.name}
                      {f.isDefault ? t("default") : ""}
                    </option>
                  ))}
                </NativeSelect>
                <p className="text-xs text-ink-3">{t("formatHint")}</p>
              </div>
            )}
          </>
        )}
      </div>
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
  /** Started from a calendar event: its title on the line. */
  eventTitle?: string | null;
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

function AgendaStepOff({ orgId, formats, onChange, disabled, initialFormat = null, startWithNewDoc = false, goals, eventTitle }: AgendaStepProps) {
  const [formatValue, setFormatValue] = useState(() => initialValue(formats, initialFormat));
  const { goalIds, onGoalChange } = useGoalTicks();
  const [prepared, setPrepared] = useState<PreparedSuggestion | null>(null);
  const [chosen, setChosen] = useState<AgendaStepViewProps["chosen"]>({ kind: "new" });
  /** The user chose something (or pressed Start): the start screen no longer picks by itself. */
  const touched = useRef(startWithNewDoc);
  if (disabled) touched.current = true;
  useEffect(() => {
    if (startWithNewDoc) return;
    let live = true;
    fetch(`/api/orgs/${orgId}/agenda-candidates`, { cache: "no-store", signal: AbortSignal.timeout(CANDIDATES_TIMEOUT_MS) })
      .then((res) => (res.ok ? (res.json() as Promise<Candidates>) : null))
      .then((json) => {
        if (!live || !json?.prepared?.accessible) return;
        const prep = json.prepared;
        setPrepared(prep);
        if (!touched.current && autoPickPrepared(prep)) setChosen({ kind: "agenda", name: prep.name, prepared: { date: prep.date, kind: prep.kind }, auto: true });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [orgId, startWithNewDoc]);
  // Before paint: Start never sees an older choice than the screen shows.
  useLayoutEffect(() => {
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
      view={prepared ? { state: "prepared", prepared } : { state: "picker-off" }}
      formats={formats}
      formatValue={formatValue}
      chosen={chosen}
      offerTranscript={false}
      transcriptInDoc={false}
      disabled={disabled}
      eventTitle={eventTitle}
      pickerOff
      onUseSuggestion={() => {}}
      onUsePrepared={() => {
        touched.current = true;
        if (prepared) setChosen({ kind: "agenda", name: prepared.name, prepared: { date: prepared.date, kind: prepared.kind } });
      }}
      onPickDoc={() => {}}
      onUseFolder={() => {}}
      onNewDoc={() => {
        touched.current = true;
        setChosen({ kind: "new" });
      }}
      onFormatChange={(v) => {
        touched.current = true;
        setFormatValue(v);
      }}
      onTranscriptChange={() => {}}
      focusChoiceOnMount={startWithNewDoc}
      goals={goals}
      goalIds={goalIds}
      onGoalChange={(id, on) => {
        touched.current = true;
        onGoalChange(id, on);
      }}
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
  eventTitle,
}: AgendaStepProps) {
  const t = useTranslations("live.agenda");
  const picker = usePicker();
  const { goalIds, onGoalChange } = useGoalTicks();
  const [view, setView] = useState<AgendaViewState>({ state: "loading" });
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  // A new Doc until something better is known: detection never holds up Start.
  const [chosen, setChosen] = useState<AgendaStepViewProps["chosen"]>({ kind: "new" });
  /** The user chose something (or "Skapa nytt dokument i stället"): the start screen no longer picks by itself. */
  const touched = useRef(startWithNewDoc);
  // Start pressed (the step is disabled while starting): the line must not change under the POST.
  if (disabled) touched.current = true;
  const [inFolder, setInFolder] = useState(false);
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
        setMessage(json?.message ?? t("folderReadFailed"));
        return;
      }
      setFolderId(json.folderId);
      setFolderName(json.folderName ?? null);
      setInFolder(Boolean(json.folderId && json.accessible));
      const suggestion = json.candidates.find((c) => c.id === json.suggestedId);
      setPrepared(json.prepared ?? null);
      if (json.prepared && !touched.current && autoPickPrepared(json.prepared)) {
        const prep = json.prepared;
        setAgendaDocId(prep.docId);
        setChosen({ kind: "agenda", name: prep.name || t("chosenFallback"), prepared: { date: prep.date, kind: prep.kind }, auto: true });
      }
      if (json.prepared) setView({ state: "prepared", prepared: json.prepared });
      else if (json.folderId && !json.accessible) setView({ state: "folder-unreachable", folderName: json.folderName ?? null });
      else if (suggestion) setView({ state: "suggestion", suggestion: { id: suggestion.id, name: suggestion.name } });
      else setView({ state: "none" });
    } catch {
      if (seq !== loadSeq.current) return;
      setView({ state: "none" });
      setMessage(t("folderReadFailed"));
    }
  }, [orgId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Before paint: Start never sees an older choice than the screen shows.
  useLayoutEffect(() => {
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
    touched.current = true;
    setAgendaDocId(doc.id);
    const prep = prepared && prepared.docId === doc.id ? { date: prepared.date, kind: prepared.kind } : undefined;
    setChosen({ kind: "agenda", name: doc.name || prepared?.name || t("chosenFallback"), ...(prep ? { prepared: prep } : {}) });
    setMessage(null);
  };

  const pickerFailed = (err: unknown) =>
    setMessage(err instanceof PickerError ? err.message : t("pickerFailed"));

  const onPickDoc = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const picked = await picker.open({ mode: "doc", parentId: folderId ?? undefined, title: t("pick") });
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
      const picked = await picker.open({ mode: "folder", title: folderName ? t("pickFolderNamed", { folder: folderName }) : t("pickFolder") });
      if (!picked?.[0]) return;
      const res = await fetch(`/api/orgs/${orgId}/meeting-folder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // grantOnly: the start screen never changes the förening's folder (only FormatCard does).
        body: JSON.stringify({ folderId: picked[0].id, grantOnly: true }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { message?: string } | null;
        setMessage(json?.message ?? t("folderSaveFailed"));
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
        touched.current = true;
        setChosen({ kind: "new" });
        setAgendaDocId(null);
        setMessage(null);
      }}
      onFormatChange={(v) => {
        touched.current = true;
        setFormatValue(v);
      }}
      onTranscriptChange={setTranscriptInDoc}
      focusChoiceOnMount={startWithNewDoc}
      inFolder={inFolder}
      eventTitle={eventTitle}
      goals={goals}
      goalIds={goalIds}
      onGoalChange={(id, on) => {
        touched.current = true;
        onGoalChange(id, on);
      }}
    />
  );
}
