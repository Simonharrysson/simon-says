"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PickerError, usePicker } from "@/components/google/Picker";
import { Banner } from "@/components/ui/Banner";
import { Button, Spinner } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { docHeadingClass, docLineClass, docPaperClass, docTitleClass } from "./doc-paper";
import { Check } from "@/components/ui/Field";
import type { ItemRole } from "@/lib/db/types";
import { editorToProfile, profileToEditor, ROLE_NAMES, type EditorItem, type EditorState } from "@/lib/formats/editor";
import type { FormatProfile } from "@/lib/formats/schema";
import { skeletonBlocks, type SkeletonBlock } from "@/lib/formats/skeleton";
import { STYRELSEPROTOKOLL, VECKOMOTE } from "@/lib/formats/standard";

// Learning a förening's format (Task B2): pick a template or 1–5 old minutes in the Google
// Picker, let Simon Says read their structure (POST …/formats/propose), then edit and approve
// the proposal here (POST …/formats). "Avbryt" drops everything: nothing is stored before approval.

export interface Proposal {
  profile: FormatProfile;
  explanation?: string | null;
  qualityNote?: string | null;
  folderId?: string | null;
}

const ROLES: ItemRole[] = ["procedural", "checkin", "followup", "topic", "other"];
const MAX_DOCS = 5;

/** The skeleton of a profile on Doc paper. */
export function FormatPreview({ profile }: { profile: FormatProfile }) {
  const blocks = skeletonBlocks(profile);
  let n = 0;
  return (
    <div className={cn(docPaperClass, "min-[60rem]:sticky min-[60rem]:top-4")} aria-label="Förhandsvisning av dokumentet">
      {blocks.map((b: SkeletonBlock, i) => {
        if (b.type === "table") {
          return (
            <table key={i} className="mt-[0.75em] w-full border-collapse [&_td]:border [&_td]:border-[#dadce0] [&_td]:px-[0.5em] [&_td]:py-[0.25em] [&_th]:w-[40%] [&_th]:border [&_th]:border-[#dadce0] [&_th]:px-[0.5em] [&_th]:py-[0.25em] [&_th]:text-left [&_th]:font-normal [&_th]:text-[#5f6368]">
              <tbody>
                {b.rows.map(([field]) => (
                  <tr key={field}>
                    <th scope="row">{field}</th>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        if (b.type === "title") return <p key={i} className={docTitleClass}>{b.text}</p>;
        if (b.type === "heading") return <p key={i} className={docHeadingClass}>{b.text}</p>;
        if (b.type === "item") {
          n++;
          return (
            <p key={i} className={docLineClass}>
              {profile.numbering === "numbered" && <span>{n}.</span>}
              <span>{b.text}</span>
            </p>
          );
        }
        if (b.type === "subitem") return <p key={i} className={cn(docLineClass, "pl-[1.5em]")}>{b.text}</p>;
        return <p key={i} className={docLineClass}>{b.text}</p>;
      })}
    </div>
  );
}

/** Focus the element with this id after React has rendered the change. */
const focusSoon = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

/** Editable list of short texts (table fields, signatures, required items). */
function TextList({
  id,
  label,
  values,
  onChange,
  addLabel,
  hint,
}: {
  id: string;
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  addLabel: string;
  hint?: string;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium text-ink">{label}</legend>
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
      {values.map((v, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <Input
            id={`${id}-${i}`}
            aria-label={`${label} ${i + 1}`}
            value={v}
            maxLength={80}
            onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <Button
            variant="danger-ghost"
            size="sm"
            aria-label={`Ta bort ${label.toLowerCase()} ${i + 1}`}
            onClick={() => {
              onChange(values.filter((_, j) => j !== i));
              // Focus stays in the list: the next row, else the previous one, else "add".
              focusSoon(values.length> 1 ? `${id}-${Math.min(i, values.length - 2)}` : `${id}-add`);
            }}
>
            Ta bort
          </Button>
        </div>
      ))}
      <div>
        <Button id={`${id}-add`} variant="ghost" size="sm" onClick={() => onChange([...values, ""])}>
          {addLabel}
        </Button>
      </div>
    </fieldset>
  );
}

export interface FormatEditorProps {
  orgId: string;
  proposal: Proposal;
  /** What the approved profile is stored as: a learned format, or a Styrelseprotokoll (C1). */
  approveKind?: "learned" | "styrelseprotokoll";
  /** Show the editable list of the stadgar's required items. */
  showRequired?: boolean;
  onCancel: () => void;
  onApproved?: () => void;
}

export function FormatEditor({ orgId, proposal, approveKind = "learned", showRequired = false, onCancel, onApproved }: FormatEditorProps) {
  const router = useRouter();
  const uid = useId();
  const itemId = (i: number, part: "label" | "up" | "down") => `${uid}-item-${i}-${part}`;
  const [state, setState] = useState<EditorState>(() => profileToEditor(proposal.profile));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const result = useMemo(() => editorToProfile(state), [state]);
  const [lastValid, setLastValid] = useState<FormatProfile>(proposal.profile);
  // Derived state: while a field is invalid the preview keeps showing the last valid profile.
  if (result.ok && JSON.stringify(result.profile) !== JSON.stringify(lastValid)) setLastValid(result.profile);
  const preview = result.ok ? result.profile : lastValid;
  const set = (patch: Partial<EditorState>) => setState((s) => ({ ...s, ...patch }));
  const setItem = (i: number, patch: Partial<EditorItem>) =>
    setState((s) => ({ ...s, items: s.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  const moveItem = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j>= state.items.length) return;
    setState((s) => {
      const items = [...s.items];
      [items[i], items[j]] = [items[j], items[i]];
      return { ...s, items };
    });
    // Focus follows the item; at the end of the list the other arrow (this one is disabled now).
    const atEdge = j === 0 || j === state.items.length - 1;
    focusSoon(itemId(j, atEdge ? (by < 0 ? "down" : "up") : by < 0 ? "up" : "down"));
  };
  const removeItem = (i: number) => {
    set({ items: state.items.filter((_, j) => j !== i) });
    focusSoon(state.items.length> 1 ? itemId(Math.min(i, state.items.length - 2), "label") : `${uid}-add-item`);
  };
  const hasCheckin = state.items.some((it) => it.role === "checkin");

  const approve = async () => {
    if (!result.ok) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/orgs/${orgId}/formats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: result.profile,
          kind: approveKind,
          ...(proposal.folderId ? { folderId: proposal.folderId } : {}),
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { message?: string } | null;
        setMessage(json?.message ?? "Formatet kunde inte sparas. Försök igen.");
        return;
      }
      router.refresh();
      onApproved?.();
    } catch {
      setMessage("Vi nådde inte servern. Kontrollera nätet och försök igen.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {proposal.explanation && <p>{proposal.explanation}</p>}
      {proposal.qualityNote && (
        <Banner tone="neutral" title="Om era gamla protokoll" live={false}>
          {proposal.qualityNote}
        </Banner>
      )}
      <div className="grid grid-cols-1 items-start gap-6 min-[60rem]:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="fe-title">
              Titel
            </Label>
            <Input id="fe-title" value={state.title} maxLength={80} onChange={(e) => set({ title: e.target.value })} />
          </div>
          <TextList
            id="fe-info"
            label="Fält i tabellen överst"
            values={state.infoTable}
            onChange={(infoTable) => set({ infoTable })}
            addLabel="Lägg till fält"
            hint="Inga fält = ingen tabell."
          />
          <div className="flex flex-col gap-2">
            <Label htmlFor="fe-agenda">
              Rubrik för dagordningen
            </Label>
            <Input
              id="fe-agenda"
              value={state.agendaHeading}
              maxLength={80}
              placeholder="Agenda"
              aria-describedby="fe-agenda-hint"
              onChange={(e) => set({ agendaHeading: e.target.value })}
            />
            {/* The skeleton always writes one (the scan finds heading items only below it). */}
            <p id="fe-agenda-hint" className="text-xs text-ink-3">
              Tomt fält ger rubriken ”Agenda”.
            </p>
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium text-ink">Punkter varje möte</legend>
            {hasCheckin && <p className="text-xs text-ink-3">Har ni ingen Må-runda? Ta bort den punkten.</p>}
            {state.items.map((item, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,11rem)] items-center gap-2 border-b border-line pb-2">
                <Input
                  id={itemId(i, "label")}
                  aria-label={`Punkt ${i + 1}`}
                  value={item.label}
                  maxLength={80}
                  onChange={(e) => setItem(i, { label: e.target.value })}
                />
                <NativeSelect
                  aria-label={`Typ av punkt ${i + 1}`}
                  value={item.role}
                  onChange={(e) => setItem(i, { role: e.target.value as ItemRole })}
>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_NAMES[r]}
                    </option>
                  ))}
                </NativeSelect>
                <label className="inline-flex cursor-pointer items-center gap-1">
                  <Checkbox checked={item.last} onCheckedChange={(on) => setItem(i, { last: on === true })} /> Sist
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <Button id={itemId(i, "up")} variant="ghost" size="sm" aria-label={`Flytta upp punkt ${i + 1}`} disabled={i === 0} onClick={() => moveItem(i, -1)}>
                    ↑
                  </Button>
                  <Button
                    id={itemId(i, "down")}
                    variant="ghost"
                    size="sm"
                    aria-label={`Flytta ner punkt ${i + 1}`}
                    disabled={i === state.items.length - 1}
                    onClick={() => moveItem(i, 1)}
>
                    ↓
                  </Button>
                  <Button variant="danger-ghost" size="sm" aria-label={`Ta bort punkt ${i + 1}`} onClick={() => removeItem(i)}>
                    Ta bort
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button id={`${uid}-add-item`} variant="ghost" size="sm" onClick={() => set({ items: [...state.items, { label: "", role: "topic", last: false }] })}>
                Lägg till punkt
              </Button>
            </div>
          </fieldset>
          {(showRequired || proposal.profile.requiredItems.length> 0) && (
            <TextList
              id="fe-required"
              label="Punkter som stadgarna kräver"
              values={state.requiredItems}
              onChange={(requiredItems) => set({ requiredItems })}
              addLabel="Lägg till punkt"
              hint="Kommer med på dagordningen varje möte."
            />
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="fe-numbering">
              Numrering
            </Label>
            <NativeSelect
              id="fe-numbering"
              value={state.numbering}
              onChange={(e) => set({ numbering: e.target.value as EditorState["numbering"] })}
>
              <option value="numbered">1. 2. 3.</option>
              <option value="paragraph">§1 §2 §3</option>
              <option value="none">Ingen</option>
            </NativeSelect>
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium text-ink">Uppgifter</legend>
            <Check id="fe-tasks-on" title="Egen rubrik för uppgifter" checked={state.tasks.on} onCheckedChange={(on) => set({ tasks: { ...state.tasks, on: on === true } })} />
            {state.tasks.on && (
              <>
                <Input
                  aria-label="Rubrik för uppgifter"
                  value={state.tasks.label}
                  maxLength={80}
                  onChange={(e) => set({ tasks: { ...state.tasks, label: e.target.value } })}
                />
                <NativeSelect
                  aria-label="Gruppera uppgifter"
                  value={state.tasks.groupBy}
                  onChange={(e) => set({ tasks: { ...state.tasks, groupBy: e.target.value as "role" | "person" } })}
>
                  <option value="role">Gruppera per roll</option>
                  <option value="person">Gruppera per person</option>
                </NativeSelect>
              </>
            )}
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium text-ink">Anteckningar</legend>
            <Check id="fe-notes-on" title="Egen rubrik för anteckningar" checked={state.notes.on} onCheckedChange={(on) => set({ notes: { ...state.notes, on: on === true } })} />
            {state.notes.on && (
              <Input
                aria-label="Rubrik för anteckningar"
                value={state.notes.label}
                maxLength={80}
                onChange={(e) => set({ notes: { ...state.notes, label: e.target.value } })}
              />
            )}
          </fieldset>
          <TextList
            id="fe-signatures"
            label="Underskrifter"
            values={state.signatures}
            onChange={(signatures) => set({ signatures })}
            addLabel="Lägg till underskrift"
            hint="Inga = inga underskrifter."
          />
        </div>
        <FormatPreview profile={preview} />
      </div>
      {!result.ok && (
        <div role="alert">
          {result.errors.map((e) => (
            <p key={e} className="flex items-center gap-2 text-xs font-medium text-red">
              {e}
            </p>
          ))}
        </div>
      )}
      {message && <Banner tone="danger">{message}</Banner>}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={busy} disabled={!result.ok} onClick={() => void approve()}>
          Godkänn och använd
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Avbryt
        </Button>
      </div>
    </div>
  );
}

export type LearnPhase =
  | { phase: "idle" }
  | { phase: "proposing" }
  | { phase: "error"; message: string }
  | { phase: "editor"; proposal: Proposal };

const COPY = {
  learn: {
    start: "Lär Simon Says ert format",
    busy: "Simon Says läser strukturen …",
    hint: "Välj en mall eller 1–5 gamla protokoll. Simon Says läser bara strukturen, aldrig innehållet.",
  },
  customize: {
    start: "Anpassa format",
    busy: "",
    hint: "Ändra det format ni använder nu, till exempel ta bort Må-runda eller lägga till en egen punkt.",
  },
  stadgar: {
    start: "Lägg in punkter från stadgarna",
    busy: "Simon Says läser stadgarna …",
    hint: "Styrelseprotokoll: välj stadgarna (Google-dokument eller PDF, högst 10 MB). Punkterna de kräver kommer med på varje dagordning. Stadgarna sparas inte.",
  },
} as const;

/** Presentational: the learn-a-format (or stadgar, C1) part of FormatCard in each phase (used by /design). */
export function LearnFormatView({
  orgId,
  view,
  variant = "learn",
  onStart,
  onCancel,
  onApproved,
}: {
  orgId: string;
  view: LearnPhase;
  variant?: "learn" | "stadgar" | "customize";
  onStart: () => void;
  onCancel: () => void;
  onApproved?: () => void;
}) {
  const copy = COPY[variant];
  const startRef = useRef<HTMLButtonElement>(null);
  const wasEditor = useRef(false);
  // Back from the editor (approved or cancelled): focus returns to the button that opened it.
  useEffect(() => {
    if (view.phase === "editor") wasEditor.current = true;
    else if (wasEditor.current) {
      wasEditor.current = false;
      startRef.current?.focus();
    }
  }, [view.phase]);
  if (view.phase === "editor") {
    return (
      <FormatEditor
        orgId={orgId}
        proposal={view.proposal}
        approveKind={variant === "stadgar" || (variant === "customize" && view.proposal.profile.kind === "styrelseprotokoll") ? "styrelseprotokoll" : "learned"}
        showRequired={variant === "stadgar" || view.proposal.profile.requiredItems.length> 0}
        onCancel={onCancel}
        onApproved={onApproved}
      />
    );
  }
  if (view.phase === "proposing") {
    return (
      <p className="text-sm text-ink-3" role="status" aria-live="polite">
        <Spinner className="align-[-0.125em]" /> {copy.busy}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {view.phase === "error" && <Banner tone="danger">{view.message}</Banner>}
      <div>
        <Button ref={startRef} variant="secondary" onClick={onStart}>
          {view.phase === "error" ? "Försök igen" : copy.start}
        </Button>
      </div>
      <p className="text-xs text-ink-3">{copy.hint}</p>
    </div>
  );
}

/** Admins: the learn-a-format flow (Picker → propose → editor → approve). */
export function LearnFormat({ orgId }: { orgId: string }) {
  const picker = usePicker();
  const [view, setView] = useState<LearnPhase>({ phase: "idle" });

  const start = async () => {
    let picked;
    try {
      picked = await picker.open({ mode: "docs-multi", title: "Välj en mall eller 1–5 gamla protokoll" });
    } catch (err) {
      setView({ phase: "error", message: err instanceof PickerError ? err.message : "Google-väljaren kunde inte öppnas. Försök igen." });
      return;
    }
    if (!picked?.length) return;
    if (picked.length> MAX_DOCS) {
      setView({ phase: "error", message: `Välj högst ${MAX_DOCS} dokument.` });
      return;
    }
    setView({ phase: "proposing" });
    try {
      const res = await fetch(`/api/orgs/${orgId}/formats/propose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docIds: picked.map((p) => p.id) }),
      });
      const json = (await res.json().catch(() => null)) as (Proposal & { message?: string }) | null;
      if (!res.ok || !json?.profile) {
        setView({ phase: "error", message: json?.message ?? "Simon Says kunde inte föreslå ett format. Försök igen." });
        return;
      }
      setView({ phase: "editor", proposal: json });
    } catch {
      setView({ phase: "error", message: "Vi nådde inte servern. Kontrollera nätet och försök igen." });
    }
  };

  return (
    <LearnFormatView
      orgId={orgId}
      view={view}
      onStart={() => void start()}
      onCancel={() => setView({ phase: "idle" })}
      onApproved={() => setView({ phase: "idle" })}
    />
  );
}

/**
 * Admins: adjust the current default directly (R3-I3), e.g. a Veckomöte without Må-runda. Opens
 * the editor on it (Enkel has no agenda: on the Veckomöte); approved as a learned format, or as a
 * Styrelseprotokoll when it is one (its stadgar items kept).
 */
export function CustomizeFormat({ orgId, current }: { orgId: string; current: FormatProfile }) {
  const [view, setView] = useState<LearnPhase>({ phase: "idle" });
  const base = current.kind === "enkel" ? VECKOMOTE : current;
  return (
    <LearnFormatView
      orgId={orgId}
      view={view}
      variant="customize"
      onStart={() => setView({ phase: "editor", proposal: { profile: base } })}
      onCancel={() => setView({ phase: "idle" })}
      onApproved={() => setView({ phase: "idle" })}
    />
  );
}

/**
 * Admins: Styrelseprotokoll with the stadgar's required items (C1): Picker → read → editor →
 * approve. Starts from the current default when it is a learned format or a Styrelseprotokoll
 * (its own items kept, R3-I3), else from the standard Styrelseprotokoll.
 */
export function StadgarFormat({ orgId, current }: { orgId: string; current?: FormatProfile }) {
  const picker = usePicker();
  const [view, setView] = useState<LearnPhase>({ phase: "idle" });

  const start = async () => {
    let picked;
    try {
      picked = await picker.open({ mode: "doc-or-pdf", title: "Välj föreningens stadgar" });
    } catch (err) {
      setView({ phase: "error", message: err instanceof PickerError ? err.message : "Google-väljaren kunde inte öppnas. Försök igen." });
      return;
    }
    if (!picked?.[0]) return;
    setView({ phase: "proposing" });
    try {
      const res = await fetch(`/api/orgs/${orgId}/formats/stadgar`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId: picked[0].id }),
      });
      const json = (await res.json().catch(() => null)) as { requiredItems?: string[]; message?: string } | null;
      if (!res.ok || !Array.isArray(json?.requiredItems)) {
        setView({ phase: "error", message: json?.message ?? "Simon Says kunde inte läsa stadgarna. Försök igen." });
        return;
      }
      setView({
        phase: "editor",
        proposal: {
          profile: {
            ...(current && (current.kind === "learned" || current.kind === "styrelseprotokoll") ? current : STYRELSEPROTOKOLL),
            requiredItems: json.requiredItems,
          },
          explanation: json.requiredItems.length
            ? `Stadgarna kräver ${json.requiredItems.length} punkter på varje styrelsemöte. Kontrollera dem nedan innan du godkänner.`
            : "Simon Says hittade inga punkter som stadgarna kräver på styrelsemöten. Du kan lägga till dem själv nedan.",
        },
      });
    } catch {
      setView({ phase: "error", message: "Vi nådde inte servern. Kontrollera nätet och försök igen." });
    }
  };

  return (
    <LearnFormatView
      orgId={orgId}
      view={view}
      variant="stadgar"
      onStart={() => void start()}
      onCancel={() => setView({ phase: "idle" })}
      onApproved={() => setView({ phase: "idle" })}
    />
  );
}
