"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PickerError, usePicker } from "@/components/google/Picker";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Check } from "@/components/ui/Field";
import type { ItemRole } from "@/lib/db/types";
import { editorToProfile, profileToEditor, ROLE_NAMES, type EditorItem, type EditorState } from "@/lib/formats/editor";
import type { FormatProfile } from "@/lib/formats/schema";
import { skeletonBlocks, type SkeletonBlock } from "@/lib/formats/skeleton";
import { STYRELSEPROTOKOLL } from "@/lib/formats/standard";

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
    <div className="doc format-preview" aria-label="Förhandsvisning av dokumentet">
      {blocks.map((b: SkeletonBlock, i) => {
        if (b.type === "table") {
          return (
            <table key={i} className="format-preview__table">
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
        if (b.type === "title") return <p key={i} className="doc__title">{b.text}</p>;
        if (b.type === "heading") return <p key={i} className="doc__h">{b.text}</p>;
        if (b.type === "item") {
          n++;
          return (
            <p key={i} className="doc__line">
              {profile.numbering === "numbered" && <span>{n}.</span>}
              <span>{b.text}</span>
            </p>
          );
        }
        if (b.type === "subitem") return <p key={i} className="doc__line format-preview__sub">{b.text}</p>;
        return <p key={i} className="doc__line">{b.text}</p>;
      })}
    </div>
  );
}

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
    <fieldset className="format-editor__group">
      <legend className="label">{label}</legend>
      {hint && <p className="hint">{hint}</p>}
      {values.map((v, i) => (
        <div key={i} className="format-editor__row">
          <input
            id={`${id}-${i}`}
            className="input"
            aria-label={`${label} ${i + 1}`}
            value={v}
            maxLength={80}
            onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <Button variant="danger-ghost" size="sm" onClick={() => onChange(values.filter((_, j) => j !== i))}>
            Ta bort
          </Button>
        </div>
      ))}
      <div>
        <Button variant="ghost" size="sm" onClick={() => onChange([...values, ""])}>
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
  const moveItem = (i: number, by: number) =>
    setState((s) => {
      const items = [...s.items];
      const j = i + by;
      if (j < 0 || j >= items.length) return s;
      [items[i], items[j]] = [items[j], items[i]];
      return { ...s, items };
    });

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
    <div className="stack stack--4 format-editor">
      {proposal.explanation && <p>{proposal.explanation}</p>}
      {proposal.qualityNote && (
        <Banner tone="neutral" title="Om era gamla protokoll" live={false}>
          {proposal.qualityNote}
        </Banner>
      )}
      <div className="format-editor__layout">
        <div className="stack stack--3">
          <div className="field">
            <label className="label" htmlFor="fe-title">
              Titel
            </label>
            <input id="fe-title" className="input" value={state.title} maxLength={80} onChange={(e) => set({ title: e.target.value })} />
          </div>
          <TextList
            id="fe-info"
            label="Fält i tabellen överst"
            values={state.infoTable}
            onChange={(infoTable) => set({ infoTable })}
            addLabel="Lägg till fält"
            hint="Inga fält = ingen tabell."
          />
          <div className="field">
            <label className="label" htmlFor="fe-agenda">
              Rubrik för dagordningen
            </label>
            <input
              id="fe-agenda"
              className="input"
              value={state.agendaHeading}
              maxLength={80}
              placeholder="Agenda"
              onChange={(e) => set({ agendaHeading: e.target.value })}
            />
          </div>
          <fieldset className="format-editor__group">
            <legend className="label">Punkter varje möte</legend>
            <p className="hint">Har ni ingen Må-runda? Ta bort den punkten.</p>
            {state.items.map((item, i) => (
              <div key={i} className="format-editor__item">
                <input
                  className="input"
                  aria-label={`Punkt ${i + 1}`}
                  value={item.label}
                  maxLength={80}
                  onChange={(e) => setItem(i, { label: e.target.value })}
                />
                <select
                  className="input"
                  aria-label={`Typ av punkt ${i + 1}`}
                  value={item.role}
                  onChange={(e) => setItem(i, { role: e.target.value as ItemRole })}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_NAMES[r]}
                    </option>
                  ))}
                </select>
                <label className="format-editor__last">
                  <input type="checkbox" checked={item.last} onChange={(e) => setItem(i, { last: e.target.checked })} /> Sist
                </label>
                <div className="cluster">
                  <Button variant="ghost" size="sm" aria-label={`Flytta upp punkt ${i + 1}`} disabled={i === 0} onClick={() => moveItem(i, -1)}>
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Flytta ner punkt ${i + 1}`}
                    disabled={i === state.items.length - 1}
                    onClick={() => moveItem(i, 1)}
                  >
                    ↓
                  </Button>
                  <Button variant="danger-ghost" size="sm" onClick={() => set({ items: state.items.filter((_, j) => j !== i) })}>
                    Ta bort
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button variant="ghost" size="sm" onClick={() => set({ items: [...state.items, { label: "", role: "topic", last: false }] })}>
                Lägg till punkt
              </Button>
            </div>
          </fieldset>
          {(showRequired || proposal.profile.requiredItems.length > 0) && (
            <TextList
              id="fe-required"
              label="Punkter som stadgarna kräver"
              values={state.requiredItems}
              onChange={(requiredItems) => set({ requiredItems })}
              addLabel="Lägg till punkt"
              hint="Kommer med på dagordningen varje möte."
            />
          )}
          <div className="field">
            <label className="label" htmlFor="fe-numbering">
              Numrering
            </label>
            <select
              id="fe-numbering"
              className="input"
              value={state.numbering}
              onChange={(e) => set({ numbering: e.target.value as EditorState["numbering"] })}
            >
              <option value="numbered">1. 2. 3.</option>
              <option value="paragraph">§1 §2 §3</option>
              <option value="none">Ingen</option>
            </select>
          </div>
          <fieldset className="format-editor__group">
            <legend className="label">Uppgifter</legend>
            <Check id="fe-tasks-on" title="Egen rubrik för uppgifter" checked={state.tasks.on} onChange={(e) => set({ tasks: { ...state.tasks, on: e.target.checked } })} />
            {state.tasks.on && (
              <>
                <input
                  className="input"
                  aria-label="Rubrik för uppgifter"
                  value={state.tasks.label}
                  maxLength={80}
                  onChange={(e) => set({ tasks: { ...state.tasks, label: e.target.value } })}
                />
                <select
                  className="input"
                  aria-label="Gruppera uppgifter"
                  value={state.tasks.groupBy}
                  onChange={(e) => set({ tasks: { ...state.tasks, groupBy: e.target.value as "role" | "person" } })}
                >
                  <option value="role">Gruppera per roll</option>
                  <option value="person">Gruppera per person</option>
                </select>
              </>
            )}
          </fieldset>
          <fieldset className="format-editor__group">
            <legend className="label">Anteckningar</legend>
            <Check id="fe-notes-on" title="Egen rubrik för anteckningar" checked={state.notes.on} onChange={(e) => set({ notes: { ...state.notes, on: e.target.checked } })} />
            {state.notes.on && (
              <input
                className="input"
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
            <p key={e} className="field-error">
              {e}
            </p>
          ))}
        </div>
      )}
      {message && <Banner tone="danger">{message}</Banner>}
      <div className="cluster">
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
  variant?: "learn" | "stadgar";
  onStart: () => void;
  onCancel: () => void;
  onApproved?: () => void;
}) {
  const copy = COPY[variant];
  if (view.phase === "editor") {
    return (
      <FormatEditor
        orgId={orgId}
        proposal={view.proposal}
        approveKind={variant === "stadgar" ? "styrelseprotokoll" : "learned"}
        showRequired={variant === "stadgar"}
        onCancel={onCancel}
        onApproved={onApproved}
      />
    );
  }
  if (view.phase === "proposing") {
    return (
      <p className="subtle" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" /> {copy.busy}
      </p>
    );
  }
  return (
    <div className="stack stack--2">
      {view.phase === "error" && <Banner tone="danger">{view.message}</Banner>}
      <div>
        <Button variant="secondary" onClick={onStart}>
          {view.phase === "error" ? "Försök igen" : copy.start}
        </Button>
      </div>
      <p className="hint">{copy.hint}</p>
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
    if (picked.length > MAX_DOCS) {
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

/** Admins: Styrelseprotokoll with the stadgar's required items (C1): Picker → read → editor → approve. */
export function StadgarFormat({ orgId }: { orgId: string }) {
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
          profile: { ...STYRELSEPROTOKOLL, requiredItems: json.requiredItems },
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
