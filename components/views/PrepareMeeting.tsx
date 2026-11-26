"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { hintClass } from "@/components/ui/Field";
import { IconArrowLeft, IconExternal, IconPlus, IconTrash } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/ui/Panel";
import { Skeleton } from "@/components/ui/skeleton";
import { addBack, addItem, bodyItems, withPending } from "@/lib/prepare/edit";
import { MEETING_TYPES, meetingTypeName, type DraftItem, type FollowupOrigin, type MeetingType } from "@/lib/prepare/types";
import { cn } from "@/lib/utils";

// "Förbered möte" (todo #6): the ordförande prepares the next meeting. Step 1 chooses the kind
// (Veckomöte preselected, "almost always") and the date; step 2 shows Simon Says' draft (standing
// items, last week's open tasks, recurring topics as suggestions) to add to, reorder and trim;
// "Skapa dagordning" writes the agenda Doc in the förening's meeting folder. Calm and quiet: one
// primary action per step, no status dots, phone width first. The förening's text is shown, never logged.

/** Swedish long date: "torsdag 3 december". */
export function longDate(date: string): string {
  return new Intl.DateTimeFormat("sv-SE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Stockholm" }).format(new Date(`${date}T12:00:00Z`));
}
/** Swedish short date: "3 dec". */
export function shortDate(date: string): string {
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", timeZone: "Europe/Stockholm" }).format(new Date(`${date}T12:00:00Z`)).replace(".", "");
}
const when = (date: string, time: string | null) => `${longDate(date)}${time ? ` kl. ${time.replace(":", ".")}` : ""}`;

// ---------------------------------------------------------------------------------------------
// Editing the draft (pure; the gallery uses them too)

export { addBack, addItem };

const onIdx = (items: DraftItem[]) => items.map((it, i) => (it.on ? i : -1)).filter((i) => i >= 0);

/** Move an item on the agenda one step up or down among the items that are on it. */
export function moveItem(items: DraftItem[], id: string, dir: -1 | 1): DraftItem[] {
  const idx = onIdx(items);
  const at = idx.findIndex((i) => items[i].id === id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= idx.length) return items;
  const out = [...items];
  [out[idx[at]], out[idx[to]]] = [out[idx[to]], out[idx[at]]];
  return out;
}

/** Take an item off the agenda: an added one is gone, a standing one or a suggestion can come back. */
export function removeItem(items: DraftItem[], id: string): DraftItem[] {
  const it = items.find((i) => i.id === id);
  if (!it) return items;
  if (it.source === "added") return items.filter((i) => i.id !== id);
  return items.map((i) => (i.id === id ? { ...i, on: false } : i));
}

export function setTask(items: DraftItem[], itemId: string, source: string, on: boolean): DraftItem[] {
  return items.map((i) => (i.id === itemId && i.tasks ? { ...i, tasks: i.tasks.map((t) => (t.source === source ? { ...t, on } : t)) } : i));
}

export function renameItem(items: DraftItem[], id: string, label: string): DraftItem[] {
  return items.map((i) => (i.id === id ? { ...i, label } : i));
}

/** Under "Från förra veckan" when there is nothing to carry: why. */
export function followupNote(origin: FollowupOrigin | undefined): string {
  if (!origin) return "Inga öppna uppgifter från förra mötet.";
  if (origin.kind === "none") return "Inget tidigare möte än. Testmöten räknas inte.";
  if (origin.kind === "too_old") return `Senaste protokollet är från ${shortDate(origin.date)} — för gammalt för att ta med uppgifter.`;
  if (origin.kind === "import") return `Inga öppna uppgifter i protokollet från ${shortDate(origin.date)}.`;
  return `Inga öppna uppgifter från mötet ${shortDate(origin.date)}. Testmöten räknas inte.`;
}

/** Above the carried tasks: where they come from. */
export function followupFrom(origin: FollowupOrigin | undefined): string {
  if (origin?.kind === "meeting") return `Öppna uppgifter från mötet ${shortDate(origin.date)}.`;
  if (origin?.kind === "import") return `Öppna uppgifter från protokollet ${shortDate(origin.date)} (inläst).`;
  return "Öppna uppgifter från förra mötet.";
}

// ---------------------------------------------------------------------------------------------
// View

export type PreparePhase =
  | { step: "type" }
  | { step: "loading" }
  | { step: "draft"; saving?: boolean; error?: string | null }
  | { step: "done"; docUrl: string; docName: string; created: boolean; reordered: boolean }
  | { step: "failed"; message: string };

export interface PrepareMeetingViewProps {
  orgName: string;
  orgHref: string;
  phase: PreparePhase;
  type: MeetingType;
  date: string;
  time: string;
  today: string;
  /** The format's display name ("Veckomöte", "Årsmöte", a förening's own name). */
  formatName?: string;
  items: DraftItem[];
  /** Preparing again: the agenda already made for this date. */
  existing?: { docUrl: string; docName: string; updatedAt: string; held: boolean } | null;
  onType(type: MeetingType): void;
  onDate(date: string): void;
  onTime(time: string): void;
  onContinue(): void;
  onBack(): void;
  onItems(items: DraftItem[]): void;
  /** Save `items` (the draft with any point still typed in "Lägg till punkt" added). */
  onSave(items: DraftItem[]): void;
  /** A fresh id for an added item. */
  newId?: () => string;
}

export function PrepareMeetingView(p: PrepareMeetingViewProps) {
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  // Each step moves focus to its heading (the button that was pressed is gone).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [p.phase.step]);

  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-6 px-gutter">
      <header className="flex flex-col gap-2">
        <a className="inline-flex items-center gap-1 self-start text-sm text-ink-3 no-underline hover:text-ink" href={p.orgHref}>
          <IconArrowLeft size={16} />
          {p.orgName}
        </a>
        <h1 className="text-2xl focus:outline-none" ref={headingRef} tabIndex={-1}>
          {p.phase.step === "done" ? "Dagordningen är klar" : "Förbered möte"}
        </h1>
        <Steps step={p.phase.step} />
      </header>
      {p.phase.step === "type" && <TypeStep {...p} uid={id} />}
      {p.phase.step === "loading" && <LoadingStep />}
      {p.phase.step === "draft" && <DraftStep {...p} phase={p.phase} uid={id} />}
      {p.phase.step === "done" && <DoneStep {...p} phase={p.phase} />}
      {p.phase.step === "failed" && (
        <Banner tone="danger" title="Det gick inte att ta fram dagordningen" live={false} action={<Button size="sm" onClick={p.onBack}>Försök igen</Button>}>
          {p.phase.message}
        </Banner>
      )}
    </div>
  );
}

function Steps({ step }: { step: PreparePhase["step"] }) {
  const n = step === "type" ? 1 : step === "done" ? 3 : 2;
  const names = ["Möte", "Dagordning", "Klart"];
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3" aria-label="Steg">
      {names.map((name, i) => (
        <li key={name} className={cn("flex items-center gap-3", i + 1 === n && "font-medium text-ink")} aria-current={i + 1 === n ? "step" : undefined}>
          <span>
            {i + 1}. {name}
          </span>
          {i < names.length - 1 && <span aria-hidden className="text-rail">—</span>}
        </li>
      ))}
    </ol>
  );
}

function TypeStep(p: PrepareMeetingViewProps & { uid: string }) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    p.onContinue();
  };
  return (
    <form className="flex flex-col gap-6" onSubmit={submit}>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-lg font-semibold">Vilket möte?</legend>
        {MEETING_TYPES.map((t) => {
          const checked = p.type === t.type;
          return (
            <label
              key={t.type}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border bg-surface p-4 transition-colors duration-120",
                checked ? "border-ink" : "border-line hover:border-control",
              )}
            >
              <input
                type="radio"
                name={`${p.uid}-type`}
                value={t.type}
                checked={checked}
                onChange={() => p.onType(t.type)}
                className="mt-1 size-4 accent-[var(--ink)]"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{t.name}</span>
                <span className={hintClass}>{t.hint}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-2">
          <Label htmlFor={`${p.uid}-date`}>Datum</Label>
          <Input id={`${p.uid}-date`} type="date" required min={p.today} value={p.date} onChange={(e) => p.onDate(e.target.value)} />
        </div>
        <div className="flex w-[9rem] flex-col gap-2">
          <Label htmlFor={`${p.uid}-time`}>
            Tid <span className="font-normal text-ink-3">(valfritt)</span>
          </Label>
          <Input id={`${p.uid}-time`} type="time" value={p.time} onChange={(e) => p.onTime(e.target.value)} />
        </div>
      </div>
      <div>
        <Button type="submit" variant="primary" size="lg" disabled={!p.date || p.date < p.today}>
          Ta fram dagordningen
        </Button>
      </div>
    </form>
  );
}

function LoadingStep() {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      <p className="text-ink-2" role="status">
        Simon Says läser förra mötet och tar fram dagordningen …
      </p>
      {[70, 55, 80, 45].map((w) => (
        <Skeleton key={w} className="h-11" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function DraftStep(p: PrepareMeetingViewProps & { phase: Extract<PreparePhase, { step: "draft" }>; uid: string }) {
  const [adding, setAdding] = useState("");
  const addRef = useRef<HTMLInputElement>(null);
  const on = p.items.filter((i) => i.on);
  const off = p.items.filter((i) => !i.on);
  const saving = p.phase.saving === true;
  const held = p.existing?.held === true;
  const typeName = meetingTypeName(p.type);
  const lock = saving || held;
  const newId = p.newId ?? (() => `add:${Math.random().toString(36).slice(2, 10)}`);

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!adding.trim()) return;
    p.onItems(addItem(p.items, adding, newId()));
    setAdding("");
    addRef.current?.focus();
  };
  // A point typed but not added ("Lägg till" never pressed) goes on the agenda too: it is put in
  // the list (so a retry after a failed save never adds it twice) and saved in the same step.
  const pending = adding.trim() !== "";
  const save = () => {
    const items = pending ? withPending(p.items, adding, newId()) : p.items;
    if (pending) {
      p.onItems(items);
      setAdding("");
    }
    p.onSave(items);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-ink-2">
          <span className="font-medium text-ink">{typeName}</span> · {when(p.date, p.time || null)}
        </p>
        {!p.existing && (
          <Button variant="ghost" size="sm" onClick={p.onBack} disabled={saving}>
            Ändra
          </Button>
        )}
      </div>

      {p.existing &&
        (held ? (
          <Banner tone="neutral" title="Mötet har redan hållits" live={false}>
            Dagordningen för {shortDate(p.date)} har redan använts. Välj ett annat datum för nästa möte.
          </Banner>
        ) : (
          <Banner tone="info" title="Du ändrar en förberedd dagordning" live={false}>
            Simon Says ändrar bara sina egna rader i dokumentet. Det någon har skrivit eller ändrat där får stå kvar.
          </Banner>
        ))}

      <Panel title="Dagordning" titleId={`${p.uid}-agenda`} flush>
        <p className={cn("-mt-2 px-6 pb-4", hintClass)}>
          Simon Says har fyllt i det vi vet. Lägg till det bara ni vet — en fest på universitetet, ett besök, en fråga någon vill ta upp.
        </p>
        <ol className="flex flex-col border-t border-line" aria-labelledby={`${p.uid}-agenda`}>
          {on.map((item, i) => (
            <AgendaRow
              key={item.id}
              item={item}
              n={i + 1}
              first={i === 0}
              last={i === on.length - 1}
              lock={lock}
              onRename={(label) => p.onItems(renameItem(p.items, item.id, label))}
              onMove={(dir) => p.onItems(moveItem(p.items, item.id, dir))}
              onRemove={() => p.onItems(removeItem(p.items, item.id))}
              onTask={(source, v) => p.onItems(setTask(p.items, item.id, source, v))}
            />
          ))}
        </ol>
        <form className="flex flex-wrap items-end gap-3 border-t border-line px-6 py-4" onSubmit={add}>
          <div className="flex min-w-[12rem] flex-1 flex-col gap-2">
            <Label htmlFor={`${p.uid}-add`}>Lägg till punkt</Label>
            <Input
              id={`${p.uid}-add`}
              ref={addRef}
              value={adding}
              maxLength={120}
              placeholder="T.ex. Fest på universitetet"
              onChange={(e) => setAdding(e.target.value)}
              disabled={lock}
            />
          </div>
          <Button type="submit" icon={<IconPlus />} disabled={lock || !adding.trim()}>
            Lägg till
          </Button>
        </form>
      </Panel>

      {off.length > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby={`${p.uid}-more`}>
          <h2 id={`${p.uid}-more`} className="text-lg">
            Fler punkter
          </h2>
          <ul className="flex flex-col gap-2">
            {off.map((item) => (
              <li key={item.id} className="flex min-h-11 flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-rail px-4 py-2">
                <span className="flex flex-col">
                  <span className="wrap-anywhere">{item.label}</span>
                  <span className={hintClass}>
                    {item.source === "suggested" ? `Har tagits upp på ${item.meetings ?? 2} möten` : "Borttagen från dagordningen"}
                  </span>
                </span>
                <Button size="sm" variant="secondary" icon={<IconPlus />} onClick={() => p.onItems(addBack(p.items, item.id))} disabled={lock}>
                  Lägg till
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.phase.error && (
        <Banner tone="danger" title="Dagordningen kunde inte sparas">
          {p.phase.error}
        </Banner>
      )}

      <div className="flex flex-col gap-3 border-t border-line pt-6">
        <p className={hintClass}>
          {p.existing
            ? "Dokumentet uppdateras där det ligger."
            : "Simon Says skapar dokumentet i föreningens mötesmapp (eller i din Drive om du inte har öppnat mappen) och delar det med medlemmarna. Ni kan fortsätta skriva i det som vanligt."}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" onClick={save} loading={saving} disabled={held || (on.length === 0 && !pending)}>
            {saving ? (p.existing ? "Uppdaterar …" : "Skapar dokumentet …") : p.existing ? "Uppdatera dagordningen" : "Skapa dagordning"}
          </Button>
          {p.existing && (
            <ButtonLink href={p.existing.docUrl} target="_blank" rel="noreferrer" variant="ghost" icon={<IconExternal />}>
              Öppna dokumentet
            </ButtonLink>
          )}
        </div>
      </div>
    </div>
  );
}

function AgendaRow(props: {
  item: DraftItem;
  n: number;
  first: boolean;
  last: boolean;
  lock: boolean;
  onRename(label: string): void;
  onMove(dir: -1 | 1): void;
  onRemove(): void;
  onTask(source: string, on: boolean): void;
}) {
  const { item, n } = props;
  const inputId = `prep-item-${item.id.replace(/[^a-z0-9]/gi, "-")}`;
  const tag: ReactNode =
    item.source === "standing" ? null : item.source === "suggested" ? <span className={hintClass}>Förslag</span> : <span className={hintClass}>Tillagd</span>;
  return (
    <li className="flex flex-col gap-3 border-b border-line px-6 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="w-6 flex-none text-right font-mono text-sm text-ink-3" aria-hidden>
          {n}.
        </span>
        <label htmlFor={inputId} className="sr-only">
          Punkt {n}
        </label>
        <Input
          id={inputId}
          className="min-w-[10rem] flex-1"
          value={item.label}
          maxLength={120}
          onChange={(e) => props.onRename(e.target.value)}
          // "Från förra veckan" keeps its name: the meeting finds last week's tasks by it.
          readOnly={Boolean(item.tasks)}
          disabled={props.lock}
        />
        <div className="ml-auto flex items-center gap-1">
          {tag}
          <Button variant="ghost" size="sm" aria-label={`Flytta upp ${item.label}`} title="Flytta upp" disabled={props.lock || props.first} onClick={() => props.onMove(-1)}>
            ↑
          </Button>
          <Button variant="ghost" size="sm" aria-label={`Flytta ner ${item.label}`} title="Flytta ner" disabled={props.lock || props.last} onClick={() => props.onMove(1)}>
            ↓
          </Button>
          <Button variant="danger-ghost" size="sm" iconOnly icon={<IconTrash />} title={`Ta bort ${item.label}`} disabled={props.lock} onClick={props.onRemove}>
            Ta bort {item.label}
          </Button>
        </div>
      </div>
      {item.tasks && (
        <div className="ml-9 flex flex-col gap-2">
          {item.tasks.length === 0 ? (
            <p className={hintClass}>{followupNote(item.origin)}</p>
          ) : (
            <>
              <p className={hintClass}>{followupFrom(item.origin)} Bocka ur det som inte ska upp.</p>
              <ul className="flex flex-col gap-1">
                {item.tasks.map((t) => {
                  const tid = `${inputId}-${t.source.replace(/[^a-z0-9]/gi, "-")}`;
                  return (
                    <li key={t.source} className="flex min-h-11 items-start gap-3">
                      <Checkbox id={tid} className="mt-1" checked={t.on} onCheckedChange={(v) => props.onTask(t.source, v === true)} disabled={props.lock} />
                      <label htmlFor={tid} className={cn("cursor-pointer text-sm wrap-anywhere", !t.on && "text-ink-3 line-through")}>
                        {t.line}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function DoneStep(p: PrepareMeetingViewProps & { phase: Extract<PreparePhase, { step: "done" }> }) {
  return (
    <div className="flex flex-col gap-6">
      <Banner tone="success" title={p.phase.created ? "Dokumentet är skapat" : "Dokumentet är uppdaterat"} live={false}>
        <span className="wrap-anywhere">{p.phase.docName}</span>
      </Banner>
      <p className="text-ink-2">
        När ni trycker <strong className="font-medium text-ink">Starta möte</strong> {p.date ? `den ${shortDate(p.date)}` : ""} föreslår Simon Says
        den här dagordningen direkt. Under mötet skrivs anteckningarna in under rätt punkt, och det som blir klart från förra veckan bockas av.
      </p>
      {!p.phase.reordered && (
        <p className={hintClass}>Någon har skrivit i dokumentet, så ordningen där är kvar som den var. Nya punkter är tillagda.</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <ButtonLink href={p.phase.docUrl} target="_blank" rel="noreferrer" variant="primary" size="lg" icon={<IconExternal />}>
          Öppna dokumentet
        </ButtonLink>
        <ButtonLink href={p.orgHref} variant="ghost">
          Till {p.orgName}
        </ButtonLink>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Container

interface DraftResponse {
  type: MeetingType;
  date: string;
  time: string | null;
  formatName: string;
  items: DraftItem[];
  existing: PrepareMeetingViewProps["existing"];
  message?: string;
}

export function PrepareMeeting(props: { orgId: string; orgName: string; today: string; defaultDate: string; defaultTime: string }) {
  const [phase, setPhase] = useState<PreparePhase>({ step: "type" });
  const [type, setType] = useState<MeetingType>("veckomote");
  const [date, setDate] = useState(props.defaultDate);
  const [time, setTime] = useState(props.defaultTime);
  const [items, setItems] = useState<DraftItem[]>([]);
  const [formatName, setFormatName] = useState<string | undefined>();
  const [existing, setExisting] = useState<PrepareMeetingViewProps["existing"]>(null);

  const load = async () => {
    setPhase({ step: "loading" });
    try {
      const res = await fetch(`/api/orgs/${props.orgId}/prepare?typ=${type}&datum=${encodeURIComponent(date)}`, { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as DraftResponse | null;
      if (!res.ok || !json) {
        setPhase({ step: "failed", message: json?.message ?? "Försök igen om en liten stund." });
        return;
      }
      setType(json.type);
      if (json.time) setTime(json.time);
      setItems(json.items);
      setFormatName(json.formatName);
      setExisting(json.existing);
      setPhase({ step: "draft" });
    } catch {
      setPhase({ step: "failed", message: "Vi nådde inte servern. Kontrollera nätet och försök igen." });
    }
  };

  const save = async (list: DraftItem[]) => {
    setPhase({ step: "draft", saving: true });
    try {
      const res = await fetch(`/api/orgs/${props.orgId}/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type,
          date,
          time: time || null,
          items: bodyItems(list),
        }),
      });
      const json = (await res.json().catch(() => null)) as { docUrl: string; docName: string; created: boolean; reordered: boolean; message?: string } | null;
      if (!res.ok || !json) {
        setPhase({ step: "draft", error: json?.message ?? "Försök igen om en liten stund." });
        return;
      }
      setPhase({ step: "done", docUrl: json.docUrl, docName: json.docName, created: json.created, reordered: json.reordered });
    } catch {
      setPhase({ step: "draft", error: "Vi nådde inte servern. Kontrollera nätet och försök igen." });
    }
  };

  return (
    <PrepareMeetingView
      orgName={props.orgName}
      orgHref={`/orgs/${props.orgId}`}
      phase={phase}
      type={type}
      date={date}
      time={time}
      today={props.today}
      formatName={formatName}
      items={items}
      existing={existing}
      onType={setType}
      onDate={setDate}
      onTime={setTime}
      onContinue={() => void load()}
      onBack={() => setPhase({ step: "type" })}
      onItems={setItems}
      onSave={(list) => void save(list)}
    />
  );
}
