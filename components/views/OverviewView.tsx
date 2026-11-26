"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button, Spinner } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconPlus, IconTrash } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel, panelFootClass, panelIntroClass, panelPadClass } from "@/components/ui/Panel";
import { formatDay, formatMonth, formatWeeks, matchesQuery } from "@/lib/dashboard/format";
import type { Overview } from "@/lib/dashboard/overview";
import type { GoalSuggestion } from "@/lib/history/digest-input";
import { HistoryImport, type ImportPhase, type ImportResult } from "./HistoryImport";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

// The förening's "Översikt" tab (org dashboard, todo #2): goals, open tasks, decisions,
// recurring topics and attendance. Everything is computed on the server from stored rows
// (lib/dashboard); this view only searches the decisions and runs the goals proposal.

export interface OverviewGoal {
  title: string;
  why: string | null;
}

export type GoalsPhase =
  | { phase: "idle" }
  | { phase: "proposing" }
  /** `warning`: the daily limit (429), which resets by itself. */
  | { phase: "error"; message: string; tone?: "warning" }
  | { phase: "editor"; goals: OverviewGoal[]; explanation?: string; suggestions?: GoalSuggestion[]; notice?: string }
  /** "Läs in gamla protokoll" (todo #7). */
  | { phase: "import"; initial?: ImportPhase };

export interface OverviewViewProps {
  orgId: string;
  isAdmin: boolean;
  overview: Overview;
  goals: OverviewGoal[];
  /** Imported old protocols (0032), shown under the goals. */
  historyCount?: number;
  /** The overview could not be read: a banner instead of the panels. */
  loadError?: boolean;
  /** /design only: the goals panel's starting phase. */
  initialGoalsPhase?: GoalsPhase;
  /** For dates ("24 nov" vs "24 nov 2025"); /design passes a fixed one. */
  now?: Date;
}

const LONG_OPEN_WEEKS = 4;
const DECISIONS_SHOWN = 12;
const TOPIC_MONTHS = 3;
const MAX_GOALS = 5;

const rowClass = "border-t border-line px-6 py-3";
const metaClass = "mt-0.5 text-sm text-ink-3";

export function OverviewView({ orgId, isAdmin, overview, goals, historyCount = 0, loadError, initialGoalsPhase, now = new Date() }: OverviewViewProps) {
  if (loadError) {
    return (
      <Banner tone="danger" title="Översikten kunde inte laddas" live={false}>
        Ladda om sidan om en liten stund. Mötena och dokumenten påverkas inte.
      </Banner>
    );
  }
  const o = overview;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink-3 max-w-[68ch]">
        {o.meetingCount === 0
          ? "Översikten fylls på när föreningen har haft sitt första möte med Simon Says."
          : `Bygger på ${plural(o.meetingCount, "avslutat möte", "avslutade möten")}${o.firstMeeting ? ` sedan ${formatDay(o.firstMeeting, now)}` : ""}. Testmöten räknas inte.`}
      </p>
      <GoalsPanel orgId={orgId} isAdmin={isAdmin} goals={goals} meetingCount={o.meetingCount} historyCount={historyCount} initial={initialGoalsPhase} />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] items-start gap-6 max-[56rem]:grid-cols-[minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <OpenTasksPanel overview={o} now={now} />
          <DecisionsPanel overview={o} now={now} />
        </div>
        <div className="flex flex-col gap-6">
          <TopicsPanel overview={o} />
          <AttendancePanel overview={o} now={now} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Goals

function GoalsPanel({
  orgId,
  isAdmin,
  goals,
  meetingCount,
  historyCount,
  initial,
}: {
  orgId: string;
  isAdmin: boolean;
  goals: OverviewGoal[];
  meetingCount: number;
  historyCount: number;
  initial?: GoalsPhase;
}) {
  const router = useRouter();
  const [clearing, setClearing] = useState<"idle" | "confirm" | "busy">("idle");
  const [view, setView] = useState<GoalsPhase>(initial ?? { phase: "idle" });
  const proposeRef = useRef<HTMLButtonElement>(null);
  const wasEditor = useRef(false);
  // Back from the editor: focus returns to the button that opened it.
  useEffect(() => {
    if (view.phase === "editor") wasEditor.current = true;
    else if (wasEditor.current) {
      wasEditor.current = false;
      proposeRef.current?.focus();
    }
  }, [view.phase]);

  const propose = async (notice?: string) => {
    setView({ phase: "proposing" });
    try {
      const res = await fetch(`/api/orgs/${orgId}/goals/propose`, { method: "POST" });
      const json = (await res.json().catch(() => null)) as
        | { goals?: OverviewGoal[]; explanation?: string; message?: string; others?: GoalSuggestion[] }
        | null;
      if (!res.ok || !json?.goals) {
        setView({
          phase: "error",
          message: `${notice ? `${notice} ` : ""}${json?.message ?? "Simon Says kunde inte föreslå mål. Försök igen."}`,
          ...(res.status === 429 ? { tone: "warning" as const } : {}),
        });
        return;
      }
      setView({ phase: "editor", goals: json.goals, explanation: json.explanation, suggestions: json.others, notice });
    } catch {
      setView({ phase: "error", message: "Vi nådde inte servern. Kontrollera nätet och försök igen." });
    }
  };

  const imported = (r: ImportResult) => {
    router.refresh();
    const parts = [
      r.imported ? `${plural(r.imported, "protokoll", "protokoll")} inlästa.` : "",
      r.failed ? `${plural(r.failed, "protokoll", "protokoll")} gick inte att läsa.` : "",
      r.stopped ?? "",
    ].filter(Boolean);
    if (!r.imported) {
      setView({ phase: "error", message: parts.join(" ") || "Inga protokoll lästes in." });
      return;
    }
    void propose(parts.join(" "));
  };

  const clearHistory = async () => {
    setClearing("busy");
    try {
      const res = await fetch(`/api/orgs/${orgId}/history`, { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { message?: string } | null;
        setView({ phase: "error", message: json?.message ?? "De inlästa protokollen kunde inte tas bort. Försök igen." });
      }
      router.refresh();
    } catch {
      setView({ phase: "error", message: "Vi nådde inte servern. Kontrollera nätet och försök igen." });
    } finally {
      setClearing("idle");
    }
  };

  const editing = view.phase === "editor" || view.phase === "import";
  return (
    <Panel
      title="Mål"
      titleId="goals-title"
      actions={
        isAdmin && !editing && view.phase !== "proposing" ? (
          <div className="flex flex-wrap gap-2">
            {goals.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setView({ phase: "editor", goals })}>
                Ändra
              </Button>
            )}
            {isAdmin && (
              <Button variant="ghost" size="sm" onClick={() => setView({ phase: "import" })}>
                Läs in gamla protokoll
              </Button>
            )}
            <Button ref={proposeRef} variant="secondary" size="sm" onClick={() => propose()}>
              Föreslå mål
            </Button>
          </div>
        ) : undefined
      }
    >
      {view.phase === "import" ? (
        <HistoryImport orgId={orgId} initial={view.initial} onDone={imported} onCancel={() => setView({ phase: "idle" })} />
      ) : view.phase === "editor" ? (
        <GoalsEditor
          orgId={orgId}
          initial={view.goals}
          explanation={[view.notice, view.explanation].filter(Boolean).join(" ")}
          suggestions={view.suggestions}
          onCancel={() => setView({ phase: "idle" })}
          onSaved={() => setView({ phase: "idle" })}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {view.phase === "proposing" && (
            <p className="text-sm text-ink-3" role="status" aria-live="polite">
              <Spinner className="align-[-0.125em]" />{" "}
              {historyCount > 0
                ? "Simon Says läser hela historiken, gamla protokoll och era möten, i tidsordning … Det kan ta någon minut."
                : "Simon Says läser besluten och punkterna från era möten …"}
            </p>
          )}
          {view.phase === "error" && <Banner tone={view.tone ?? "danger"}>{view.message}</Banner>}
          {goals.length > 0 ? (
            <ol className="flex flex-col gap-3" aria-labelledby="goals-title">
              {goals.map((g, i) => (
                <li key={`${i}-${g.title}`} className="flex gap-3">
                  <span className="w-5 flex-none text-right text-ink-3 tabular-nums">{i + 1}.</span>
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium wrap-anywhere">{g.title}</span>
                    {g.why && <span className="text-sm text-ink-3">{g.why}</span>}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            view.phase !== "proposing" && (
              <EmptyState title="Inga mål än">
                <p>
                  {isAdmin
                    ? meetingCount >= 3
                      ? "Låt Simon Says föreslå 3–5 mål utifrån det som återkommer på era möten. Du ändrar och godkänner dem innan någon annan ser dem."
                      : "Simon Says kan föreslå mål när föreningen har haft minst 3 möten. Du kan skriva egna mål redan nu."
                    : "När en admin har godkänt föreningens mål syns de här."}
                </p>
              </EmptyState>
            )
          )}
          {historyCount > 0 && view.phase !== "proposing" && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink-3">
              <span>Förslagen bygger också på {plural(historyCount, "inläst gammalt protokoll", "inlästa gamla protokoll")}.</span>
              {isAdmin &&
                (clearing === "idle" ? (
                  <Button variant="ghost" size="sm" onClick={() => setClearing("confirm")}>
                    Ta bort dem
                  </Button>
                ) : (
                  <>
                    <span>Ta bort alla inlästa protokoll? Godkända mål ligger kvar.</span>
                    <Button variant="danger-ghost" size="sm" loading={clearing === "busy"} onClick={clearHistory}>
                      Ta bort
                    </Button>
                    <Button variant="ghost" size="sm" disabled={clearing === "busy"} onClick={() => setClearing("idle")}>
                      Avbryt
                    </Button>
                  </>
                ))}
            </div>
          )}
          {isAdmin && goals.length === 0 && view.phase !== "proposing" && (
            <div>
              <Button variant="ghost" size="sm" icon={<IconPlus size={16} />} onClick={() => setView({ phase: "editor", goals: [{ title: "", why: null }] })}>
                Skriv egna mål
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function GoalsEditor({
  orgId,
  initial,
  explanation,
  suggestions = [],
  onCancel,
  onSaved,
}: {
  orgId: string;
  initial: OverviewGoal[];
  explanation?: string;
  /** From the whole-history digest: goals with their status, the admin may add them. */
  suggestions?: GoalSuggestion[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const uid = useId();
  const [goals, setGoals] = useState(() => initial.map((g) => ({ title: g.title, why: g.why ?? "" })));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const titleId = (i: number) => `${uid}-goal-${i}`;
  const focusSoon = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 0);
  const set = (i: number, patch: Partial<{ title: string; why: string }>) => setGoals((gs) => gs.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const remove = (i: number) => {
    setGoals((gs) => gs.filter((_, j) => j !== i));
    focusSoon(goals.length > 1 ? titleId(Math.max(0, Math.min(i, goals.length - 2))) : `${uid}-add`);
  };
  const add = () => {
    setGoals((gs) => [...gs, { title: "", why: "" }]);
    focusSoon(titleId(goals.length));
  };
  const empty = goals.some((g) => !g.title.trim());
  const [added, setAdded] = useState<Set<number>>(() => new Set());
  const addSuggestion = (k: number) => {
    const sg = suggestions[k];
    setGoals((gs) => [...gs, { title: sg.title, why: sg.why ?? "" }]);
    setAdded((a) => new Set(a).add(k));
  };

  const save = async () => {
    if (empty) {
      setMessage("Varje mål behöver en titel. Ta bort de mål du inte vill ha.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/orgs/${orgId}/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goals: goals.map((g) => ({ title: g.title, why: g.why || null })) }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { message?: string } | null;
        setMessage(json?.message ?? "Målen kunde inte sparas. Försök igen.");
        return;
      }
      router.refresh();
      onSaved();
    } catch {
      setMessage("Vi nådde inte servern. Kontrollera nätet och försök igen.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {explanation && <p>{explanation}</p>}
      <p className="text-sm text-ink-3">
        Ändra, ta bort eller lägg till. Alla i föreningen ser målen när du har godkänt dem. Högst {MAX_GOALS} mål.
      </p>
      <ol className="flex flex-col">
        {goals.map((g, i) => (
          <li key={i} className="flex items-start gap-3 border-t border-line py-4 first:border-t-0 first:pt-0">
            <span className="w-5 flex-none pt-2.5 text-right text-ink-3 tabular-nums">{i + 1}.</span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor={titleId(i)} className="sr-only">
                Mål {i + 1}
              </Label>
              <Input id={titleId(i)} value={g.title} maxLength={80} placeholder="Målet, t.ex. Fler medlemmar till våren" onChange={(e) => set(i, { title: e.target.value })} />
              <Label htmlFor={`${titleId(i)}-why`} className="sr-only">
                Varför, mål {i + 1}
              </Label>
              <Input
                id={`${titleId(i)}-why`}
                value={g.why}
                maxLength={240}
                placeholder="Varför (valfritt)"
                className="text-sm"
                onChange={(e) => set(i, { why: e.target.value })}
              />
            </div>
            <Button variant="danger-ghost" size="sm" iconOnly icon={<IconTrash size={18} />} onClick={() => remove(i)}>
              {`Ta bort mål ${i + 1}`}
            </Button>
          </li>
        ))}
      </ol>
      {goals.length < MAX_GOALS && (
        <div>
          <Button id={`${uid}-add`} variant="ghost" size="sm" icon={<IconPlus size={16} />} onClick={add}>
            Lägg till mål
          </Button>
        </div>
      )}
      {suggestions.length > 0 && <SuggestionList suggestions={suggestions} added={added} full={goals.length >= MAX_GOALS} onAdd={addSuggestion} />}
      {message && <Banner tone="danger">{message}</Banner>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={save} loading={busy}>
          {goals.length ? "Godkänn målen" : "Spara utan mål"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Avbryt
        </Button>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<GoalSuggestion["status"], string> = {
  current: "Pågår",
  achieved: "Uppnått",
  dropped: "Avbrutet",
  stale: "Tystnat",
};

/** The digest's other goals (achieved, dropped, gone quiet, current beyond 5): context, addable. */
function SuggestionList({
  suggestions,
  added,
  full,
  onAdd,
}: {
  suggestions: GoalSuggestion[];
  added: Set<number>;
  full: boolean;
  onAdd: (k: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">Övriga mål i historiken</h3>
      <p className="text-sm text-ink-3">Nådda, avbrutna och sådana som inte nämnts på länge. De syns inte för andra om du inte lägger till dem.</p>
      <ul className="flex flex-col">
        {suggestions.map((sg, k) => (
          <li key={`${k}-${sg.title}`} className="flex items-start gap-3 border-t border-line py-3 first:border-t-0">
            <Badge tone={sg.status === "achieved" ? "success" : sg.status === "current" ? "info" : "neutral"}>{STATUS_LABEL[sg.status]}</Badge>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium wrap-anywhere">{sg.title}</span>
              <span className="text-sm text-ink-3">
                {sg.why ? `${sg.why} ` : ""}Senast nämnt {sg.lastMentioned}.
              </span>
            </span>
            {!added.has(k) && !full && (
              <Button variant="ghost" size="sm" icon={<IconPlus size={16} />} onClick={() => onAdd(k)}>
                Lägg till
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Open tasks

function OpenTasksPanel({ overview, now }: { overview: Overview; now: Date }) {
  const count = overview.openTasks.reduce((n, g) => n + g.tasks.length, 0);
  return (
    <Panel flush title="Öppna uppgifter" titleId="tasks-title" actions={<span className="text-sm text-ink-3 tabular-nums">{count}</span>}>
      <p className={cn(panelIntroClass, "text-sm text-ink-3")}>Det som inte är klart, äldst först. Uppgifter som följt med i {LONG_OPEN_WEEKS} veckor eller mer är markerade.</p>
      {count === 0 ? (
        <div className={panelPadClass}>
          <EmptyState title="Inga öppna uppgifter">
            <p>Uppgifter från mötena hamnar här tills någon bockar av dem i protokollet.</p>
          </EmptyState>
        </div>
      ) : (
        <div>
          {overview.openTasks.map((g) => (
            <section key={g.key} aria-label={g.label} className="border-t border-line">
              <h3 className="flex flex-wrap items-baseline gap-x-2 bg-board px-6 py-2 text-sm font-medium">
                <span>{g.label}</span>
                {g.role && <span className="font-normal text-ink-3">{g.role}</span>}
              </h3>
              <ul>
                {g.tasks.map((t) => (
                  <li key={t.key} className={rowClass}>
                    <p className="wrap-anywhere">{t.text}</p>
                    <p className={metaClass}>
                      <Badge tone={t.weeks >= LONG_OPEN_WEEKS ? "alert" : "neutral"} className="mr-2 inline-flex align-[0.05em]">{formatWeeks(t.weeks)}</Badge>
                      <span>{[`sedan ${formatDay(t.since, now)}`, t.item, t.due && `klart senast ${t.due}`].filter(Boolean).join(" · ")}</span>
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Decisions

function DecisionsPanel({ overview, now }: { overview: Overview; now: Date }) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const hits = useMemo(
    () => overview.decisions.filter((d) => matchesQuery(`${d.text} ${d.item ?? ""}`, query)),
    [overview.decisions, query],
  );
  const searching = query.trim() !== "";
  const shown = searching || all ? hits : hits.slice(0, DECISIONS_SHOWN);
  return (
    <Panel flush title="Beslut" titleId="decisions-title" actions={<span className="text-sm text-ink-3 tabular-nums">{overview.decisions.length}</span>}>
      {overview.decisions.length === 0 ? (
        <div className={panelPadClass}>
          <EmptyState title="Inga beslut än">
            <p>Besluten från föreningens möten det senaste året hamnar här, med datum och dagordningspunkt.</p>
          </EmptyState>
        </div>
      ) : (
        <>
          <div className={cn(panelIntroClass, "flex flex-col gap-2")}>
            <Label htmlFor="decision-search">Sök bland besluten</Label>
            <Input
              id="decision-search"
              type="search"
              value={query}
              placeholder="t.ex. hyran"
              autoComplete="off"
              aria-describedby="decision-search-hint"
              onChange={(e) => setQuery(e.target.value)}
            />
            <p id="decision-search-hint" className="text-sm text-ink-3" aria-live="polite">
              {searching ? plural(hits.length, "beslut matchar", "beslut matchar") : "Det senaste året, nyast först."}
            </p>
          </div>
          {shown.length === 0 ? (
            <p className={cn(rowClass, "text-sm text-ink-3")}>Inga beslut matchar ”{query.trim()}”.</p>
          ) : (
            <ul aria-labelledby="decisions-title">
              {shown.map((d) => (
                <li key={d.key} className={rowClass}>
                  <p className="wrap-anywhere">{d.text}</p>
                  <p className={metaClass}>
                    <span>{[formatDay(d.date, now), d.item].filter(Boolean).join(" · ")}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
          {!searching && hits.length > DECISIONS_SHOWN && (
            <div className={panelFootClass}>
              <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
                {all ? "Visa färre" : `Visa alla ${hits.length}`}
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Recurring topics

function TopicsPanel({ overview }: { overview: Overview }) {
  return (
    <Panel flush title="Återkommande punkter" titleId="topics-title">
      <p className={cn(panelIntroClass, "text-sm text-ink-3")}>Punkter på dagordningen som kommit tillbaka, och vad som beslutades under dem.</p>
      {overview.topics.length === 0 ? (
        <div className={panelPadClass}>
          <EmptyState title="Inga återkommande punkter än">
            <p>Syns när samma punkt har stått på dagordningen vid minst två möten.</p>
          </EmptyState>
        </div>
      ) : (
        <ul aria-labelledby="topics-title">
          {overview.topics.map((t) => (
            <li key={t.label} className={rowClass}>
              <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium wrap-anywhere">{t.label}</span>
                <span className="text-sm text-ink-3 tabular-nums">{plural(t.meetings, "möte", "möten")}</span>
              </p>
              {t.months.length > 0 ? (
                <div className="mt-2 flex flex-col gap-2">
                  {t.months.slice(0, TOPIC_MONTHS).map((m) => (
                    <div key={m.month}>
                      <p className="text-sm text-ink-3 first-letter:uppercase">{formatMonth(m.month)}</p>
                      <ul className="list-dash pl-5 text-sm">
                        {m.decisions.map((d, i) => (
                          <li key={i} className="wrap-anywhere">
                            {d}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-sm text-ink-3">Inga beslut under punkten än.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Attendance

function AttendancePanel({ overview, now }: { overview: Overview; now: Date }) {
  const a = overview.attendance;
  return (
    <Panel flush title="Närvaro" titleId="attendance-title">
      <p className={cn(panelIntroClass, "text-sm text-ink-3")}>
        {a.meetings > 0
          ? `Vem som hördes och fick sitt namn på ${plural(a.meetings, "möte", "möten")}. Den som var med men inte sa något syns inte.`
          : "Vem som hördes och fick sitt namn på mötena. Syns efter första mötet med namnrunda."}
      </p>
      {a.meetings > 0 && a.people.length > 0 && (
        <ul aria-labelledby="attendance-title">
          {a.people.map((p) => {
            const share = a.meetings ? p.attended / a.meetings : 0;
            return (
              <li key={p.personId} className={cn(rowClass, "flex flex-col gap-1.5")}>
                <p className="flex items-baseline justify-between gap-3">
                  <span className="font-medium wrap-anywhere">{p.name}</span>
                  <span className="flex-none text-sm text-ink-3 tabular-nums">
                    {p.attended} av {a.meetings}
                  </span>
                </p>
                <div className="h-1 overflow-hidden rounded-full bg-sunk" aria-hidden="true">
                  <div className="h-full rounded-full bg-ink-3" style={{ width: `${Math.round(share * 100)}%` }} />
                </div>
                {p.lastSeen && <p className="text-xs text-ink-3">Senast {formatDay(p.lastSeen, now)}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {a.meetings > 0 && a.people.length === 0 && (
        <p className={cn(panelPadClass, "text-sm text-ink-3")}>Lägg till personer under Möten för att se närvaron per person.</p>
      )}
      {a.meetings === 0 && <div className="pb-2" />}
    </Panel>
  );
}
