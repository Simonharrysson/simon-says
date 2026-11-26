"use client";

import { useLocale, useTranslations } from "next-intl";
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
import { isGoalItem, MEETING_TYPES, type DraftItem, type FollowupOrigin, type MeetingType } from "@/lib/prepare/types";
import { defaultLocale, intlTag, type Locale } from "@/lib/i18n/config";
import { translator } from "@/lib/i18n/translator";
import { cn } from "@/lib/utils";

// "Förbered möte" (todo #6): the ordförande prepares the next meeting. Step 1 chooses the kind
// (Veckomöte preselected, "almost always") and the date; step 2 shows Simon Says' draft (standing
// items, last week's open tasks, recurring topics as suggestions) to add to, reorder and trim;
// "Skapa dagordning" writes the agenda Doc in the förening's meeting folder. Calm and quiet: one
// primary action per step, no status dots, phone width first. The förening's text is shown, never logged.

/** Long date: "torsdag 3 december" (en: "Thursday 3 December"). */
export function longDate(date: string, locale: Locale = defaultLocale): string {
  return new Intl.DateTimeFormat(intlTag(locale), { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Stockholm" }).format(new Date(`${date}T12:00:00Z`));
}
/** Short date: "3 dec" (en: "3 Dec"). */
export function shortDate(date: string, locale: Locale = defaultLocale): string {
  return new Intl.DateTimeFormat(intlTag(locale), { day: "numeric", month: "short", timeZone: "Europe/Stockholm" }).format(new Date(`${date}T12:00:00Z`)).replace(".", "");
}
const when = (date: string, time: string | null, locale: Locale) =>
  time ? translator(locale)("prepare.at", { date: longDate(date, locale), time: locale === "en" ? time : time.replace(":", ".") }) : longDate(date, locale);

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
export function followupNote(origin: FollowupOrigin | undefined, locale: Locale = defaultLocale): string {
  const t = translator(locale);
  if (!origin) return t("prepare.noteNone");
  if (origin.kind === "none") return t("prepare.noteNoMeeting");
  if (origin.kind === "too_old") return t("prepare.noteTooOld", { date: shortDate(origin.date, locale) });
  if (origin.kind === "import") return t("prepare.noteImport", { date: shortDate(origin.date, locale) });
  return t("prepare.noteMeeting", { date: shortDate(origin.date, locale) });
}

/** Above the carried tasks: where they come from. */
export function followupFrom(origin: FollowupOrigin | undefined, locale: Locale = defaultLocale): string {
  const t = translator(locale);
  if (origin?.kind === "meeting") return t("prepare.fromMeeting", { date: shortDate(origin.date, locale) });
  if (origin?.kind === "import") return t("prepare.fromImport", { date: shortDate(origin.date, locale) });
  return t("prepare.fromLast");
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
  /** Opened from a calendar event (todo #14): its title, shown and put in the Doc's name. */
  eventTitle?: string | null;
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
  const t = useTranslations("prepare");
  const tCal = useTranslations("calendar");
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
          {p.phase.step === "done" ? t("doneTitle") : t("title")}
        </h1>
        {p.eventTitle && <p className="text-sm text-ink-2">{tCal("fromCalendar", { title: p.eventTitle })}</p>}
        <Steps step={p.phase.step} />
      </header>
      {p.phase.step === "type" && <TypeStep {...p} uid={id} />}
      {p.phase.step === "loading" && <LoadingStep />}
      {p.phase.step === "draft" && <DraftStep {...p} phase={p.phase} uid={id} />}
      {p.phase.step === "done" && <DoneStep {...p} phase={p.phase} />}
      {p.phase.step === "failed" && (
        <Banner tone="danger" title={t("failedTitle")} live={false} action={<Button size="sm" onClick={p.onBack}>{t("tryAgain")}</Button>}>
          {p.phase.message}
        </Banner>
      )}
    </div>
  );
}

function Steps({ step }: { step: PreparePhase["step"] }) {
  const t = useTranslations("prepare");
  const n = step === "type" ? 1 : step === "done" ? 3 : 2;
  const names = [t("stepNames.meeting"), t("stepNames.agenda"), t("stepNames.done")];
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3" aria-label={t("steps")}>
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
  const t = useTranslations("prepare");
  const types = useTranslations("formats.meetingTypes");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    p.onContinue();
  };
  return (
    <form className="flex flex-col gap-6" onSubmit={submit}>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-lg font-semibold">{t("whichMeeting")}</legend>
        {MEETING_TYPES.map((mt) => {
          const checked = p.type === mt.type;
          return (
            <label
              key={mt.type}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border bg-surface p-4 transition-colors duration-120",
                checked ? "border-ink" : "border-line hover:border-control",
              )}
            >
              <input
                type="radio"
                name={`${p.uid}-type`}
                value={mt.type}
                checked={checked}
                onChange={() => p.onType(mt.type)}
                className="mt-1 size-4 accent-[var(--ink)]"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{types(`${mt.type}.name`)}</span>
                <span className={hintClass}>{types(`${mt.type}.hint`)}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-2">
          <Label htmlFor={`${p.uid}-date`}>{t("date")}</Label>
          <Input id={`${p.uid}-date`} type="date" required min={p.today} value={p.date} onChange={(e) => p.onDate(e.target.value)} />
        </div>
        <div className="flex w-[9rem] flex-col gap-2">
          <Label htmlFor={`${p.uid}-time`}>
            {t("time")} <span className="font-normal text-ink-3">{t("optional")}</span>
          </Label>
          <Input id={`${p.uid}-time`} type="time" value={p.time} onChange={(e) => p.onTime(e.target.value)} />
        </div>
      </div>
      <div>
        <Button type="submit" variant="primary" size="lg" disabled={!p.date || p.date < p.today}>
          {t("makeAgenda")}
        </Button>
      </div>
    </form>
  );
}

function LoadingStep() {
  const t = useTranslations("prepare");
  return (
    <div className="flex flex-col gap-3" aria-busy>
      <p className="text-ink-2" role="status">
        {t("loading")}
      </p>
      {[70, 55, 80, 45].map((w) => (
        <Skeleton key={w} className="h-11" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function DraftStep(p: PrepareMeetingViewProps & { phase: Extract<PreparePhase, { step: "draft" }>; uid: string }) {
  const t = useTranslations("prepare");
  const types = useTranslations("formats.meetingTypes");
  const locale = useLocale();
  const [adding, setAdding] = useState("");
  const addRef = useRef<HTMLInputElement>(null);
  const on = p.items.filter((i) => i.on);
  // "Mål att ta upp" (todo #12): the goals Simon Says suggests, apart from the other points.
  const offGoals = p.items.filter((i) => !i.on && isGoalItem(i));
  const off = p.items.filter((i) => !i.on && !isGoalItem(i));
  const saving = p.phase.saving === true;
  const held = p.existing?.held === true;
  const typeName = MEETING_TYPES.some((mt) => mt.type === p.type) ? types(`${p.type}.name`) : "";
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
          <span className="font-medium text-ink">{typeName}</span> · {when(p.date, p.time || null, locale)}
        </p>
        {!p.existing && (
          <Button variant="ghost" size="sm" onClick={p.onBack} disabled={saving}>
            {t("change")}
          </Button>
        )}
      </div>

      {p.existing &&
        (held ? (
          <Banner tone="neutral" title={t("heldTitle")} live={false}>
            {t("heldText", { date: shortDate(p.date, locale) })}
          </Banner>
        ) : (
          <Banner tone="info" title={t("editingTitle")} live={false}>
            {t("editingText")}
          </Banner>
        ))}

      <Panel title={t("agenda")} titleId={`${p.uid}-agenda`} flush>
        <p className={cn("-mt-2 px-6 pb-4", hintClass)}>
          {t("agendaHint")}
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
            <Label htmlFor={`${p.uid}-add`}>{t("addItem")}</Label>
            <Input
              id={`${p.uid}-add`}
              ref={addRef}
              value={adding}
              maxLength={120}
              placeholder={t("addPlaceholder")}
              onChange={(e) => setAdding(e.target.value)}
              disabled={lock}
            />
          </div>
          <Button type="submit" icon={<IconPlus />} disabled={lock || !adding.trim()}>
            {t("add")}
          </Button>
        </form>
      </Panel>

      {offGoals.length > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby={`${p.uid}-goals`}>
          <div className="flex flex-col gap-1">
            <h2 id={`${p.uid}-goals`} className="text-lg">
              {t("goalsTitle")}
            </h2>
            <p className={hintClass}>{t("goalsHint")}</p>
          </div>
          <ul className="flex flex-col gap-2">
            {offGoals.map((item) => (
              <li key={item.id} className="flex min-h-11 flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-rail px-4 py-2">
                <span className="flex flex-col">
                  <span className="wrap-anywhere">{item.label}</span>
                  <span className={hintClass}>{item.reason ?? t("goalFallback")}</span>
                </span>
                <Button size="sm" variant="secondary" icon={<IconPlus />} onClick={() => p.onItems(addBack(p.items, item.id))} disabled={lock}>
                  {t("add")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {off.length > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby={`${p.uid}-more`}>
          <h2 id={`${p.uid}-more`} className="text-lg">
            {t("moreItems")}
          </h2>
          <ul className="flex flex-col gap-2">
            {off.map((item) => (
              <li key={item.id} className="flex min-h-11 flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-rail px-4 py-2">
                <span className="flex flex-col">
                  <span className="wrap-anywhere">{item.label}</span>
                  <span className={hintClass}>
                    {item.source === "suggested" ? t("raisedAt", { count: item.meetings ?? 2 }) : t("removed")}
                  </span>
                </span>
                <Button size="sm" variant="secondary" icon={<IconPlus />} onClick={() => p.onItems(addBack(p.items, item.id))} disabled={lock}>
                  {t("add")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.phase.error && (
        <Banner tone="danger" title={t("saveFailed")}>
          {p.phase.error}
        </Banner>
      )}

      <div className="flex flex-col gap-3 border-t border-line pt-6">
        <p className={hintClass}>
          {p.existing ? t("updatedInPlace") : t("createNote")}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" onClick={save} loading={saving} disabled={held || (on.length === 0 && !pending)}>
            {saving ? (p.existing ? t("updating") : t("creating")) : p.existing ? t("update") : t("create")}
          </Button>
          {p.existing && (
            <ButtonLink href={p.existing.docUrl} target="_blank" rel="noreferrer" variant="ghost" icon={<IconExternal />}>
              {t("openDoc")}
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
  const t = useTranslations("prepare");
  const locale = useLocale();
  const { item, n } = props;
  const inputId = `prep-item-${item.id.replace(/[^a-z0-9]/gi, "-")}`;
  const tag: ReactNode =
    item.source === "standing" ? null : isGoalItem(item) ? (
      <span className={hintClass}>{t("tagGoal")}</span>
    ) : item.source === "suggested" ? (
      <span className={hintClass}>{t("tagSuggested")}</span>
    ) : (
      <span className={hintClass}>{t("tagAdded")}</span>
    );
  return (
    <li className="flex flex-col gap-3 border-b border-line px-6 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="w-6 flex-none text-right font-mono text-sm text-ink-3" aria-hidden>
          {n}.
        </span>
        <label htmlFor={inputId} className="sr-only">
          {t("itemN", { n })}
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
          <Button variant="ghost" size="sm" aria-label={t("moveUpItem", { label: item.label })} title={t("moveUp")} disabled={props.lock || props.first} onClick={() => props.onMove(-1)}>
            ↑
          </Button>
          <Button variant="ghost" size="sm" aria-label={t("moveDownItem", { label: item.label })} title={t("moveDown")} disabled={props.lock || props.last} onClick={() => props.onMove(1)}>
            ↓
          </Button>
          <Button variant="danger-ghost" size="sm" iconOnly icon={<IconTrash />} title={t("removeItem", { label: item.label })} disabled={props.lock} onClick={props.onRemove}>
            {t("removeItem", { label: item.label })}
          </Button>
        </div>
      </div>
      {item.tasks && (
        <div className="ml-9 flex flex-col gap-2">
          {item.tasks.length === 0 ? (
            <p className={hintClass}>{followupNote(item.origin, locale)}</p>
          ) : (
            <>
              <p className={hintClass}>
                {followupFrom(item.origin, locale)} {t("untick")}
              </p>
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
  const t = useTranslations("prepare");
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-6">
      <Banner tone="success" title={p.phase.created ? t("created") : t("updated")} live={false}>
        <span className="wrap-anywhere">{p.phase.docName}</span>
      </Banner>
      <p className="text-ink-2">
        {t.rich("doneText", {
          when: p.date ? t("onDate", { date: shortDate(p.date, locale) }) : "",
          strong: (chunks) => <strong className="font-medium text-ink">{chunks}</strong>,
        })}
      </p>
      {!p.phase.reordered && (
        <p className={hintClass}>{t("kept")}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <ButtonLink href={p.phase.docUrl} target="_blank" rel="noreferrer" variant="primary" size="lg" icon={<IconExternal />}>
          {t("openDoc")}
        </ButtonLink>
        <ButtonLink href={p.orgHref} variant="ghost">
          {t("toOrg", { org: p.orgName })}
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

export function PrepareMeeting(props: { orgId: string; orgName: string; today: string; defaultDate: string; defaultTime: string; eventTitle?: string | null }) {
  const t = useTranslations("prepare");
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
        setPhase({ step: "failed", message: json?.message ?? t("retryLater") });
        return;
      }
      setType(json.type);
      if (json.time) setTime(json.time);
      setItems(json.items);
      setFormatName(json.formatName);
      setExisting(json.existing);
      setPhase({ step: "draft" });
    } catch {
      setPhase({ step: "failed", message: t("offline") });
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
          ...(props.eventTitle ? { eventTitle: props.eventTitle } : {}),
          items: bodyItems(list),
        }),
      });
      const json = (await res.json().catch(() => null)) as { docUrl: string; docName: string; created: boolean; reordered: boolean; message?: string } | null;
      if (!res.ok || !json) {
        setPhase({ step: "draft", error: json?.message ?? t("retryLater") });
        return;
      }
      setPhase({ step: "done", docUrl: json.docUrl, docName: json.docName, created: json.created, reordered: json.reordered });
    } catch {
      setPhase({ step: "draft", error: t("offline") });
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
      eventTitle={props.eventTitle}
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
