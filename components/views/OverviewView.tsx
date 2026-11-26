"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button, Spinner } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconPlus, IconTrash } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/ui/Panel";
import { basisLine } from "@/lib/dashboard/format";
import type { Overview } from "@/lib/dashboard/overview";
import type { GoalSuggestion } from "@/lib/history/digest-input";
import type { JobView } from "@/lib/history/progress";
import { HistoryImport, type ImportAccess, type ImportPhase, type ImportResult } from "./HistoryImport";
import { plural } from "@/lib/format";

// The förening's "Översikt" tab (org dashboard, todo #2): the goals (Mål) and the old-protocol
// import. The basis line is computed on the server (lib/dashboard); this view runs the goals proposal.

export interface OverviewGoal {
  title: string;
  why: string | null;
  /** Whole-history proposals only: the dated lines the goal rests on (never stored). */
  evidence?: { date: string; text: string }[];
}

export type GoalsPhase =
  | { phase: "idle" }
  | { phase: "proposing" }
  /** `warning`: the daily limit (429), which resets by itself. */
  | { phase: "error"; message: string; tone?: "warning" }
  | { phase: "editor"; goals: OverviewGoal[]; explanation?: string; suggestions?: GoalSuggestion[]; notice?: string }
  /** "Läs in gamla protokoll" (todo #7). `consent`: back from Google's drive.readonly consent. */
  | { phase: "import"; initial?: ImportPhase; consent?: "ok" | "nej" | "fel" | "konto"; demoNow?: number };

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
  /** The protocol import (admins): the drive.readonly grant and the förening's meeting folder. */
  importAccess?: ImportAccess;
  /** For dates ("24 nov" vs "24 nov 2025"); /design passes a fixed one. */
  now?: Date;
  /** Admins: an import that is running, or finished and not yet closed (0036); shown in the goals card. */
  importJob?: JobView | null;
}

const MAX_GOALS = 5;

export function OverviewView({ orgId, isAdmin, overview, goals, historyCount = 0, loadError, initialGoalsPhase, importAccess, importJob, now = new Date() }: OverviewViewProps) {
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
      <p className="text-sm text-ink-3 max-w-[68ch]">{basisLine(o, now)}</p>
      <GoalsPanel orgId={orgId} isAdmin={isAdmin} goals={goals} canPropose={o.meetingCount >= 3 || historyCount > 0 || o.imported.count > 0} historyCount={historyCount} initial={initialGoalsPhase ?? (isAdmin && importJob ? { phase: "import", initial: { phase: "job", job: importJob } } : undefined)} importAccess={importAccess} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Goals

function GoalsPanel({
  orgId,
  isAdmin,
  goals,
  canPropose,
  historyCount,
  initial,
  importAccess = { driveReadonly: false, email: null, meetingFolder: null },
}: {
  orgId: string;
  isAdmin: boolean;
  goals: OverviewGoal[];
  /** At least 3 own meetings, or imported protocols (the proposal reads the whole history). */
  canPropose: boolean;
  historyCount: number;
  initial?: GoalsPhase;
  importAccess?: ImportAccess;
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
        <HistoryImport
          orgId={orgId}
          access={importAccess}
          consent={view.consent}
          initial={view.initial}
          demoNow={view.demoNow}
          onDone={imported}
          onProposal={(proposal, notice) => {
            router.refresh();
            setView({ phase: "editor", goals: proposal.goals, explanation: proposal.explanation, suggestions: proposal.others, notice });
          }}
          onCancel={() => {
            router.refresh();
            setView({ phase: "idle" });
          }}
        />
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
                    ? canPropose
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
  const [goals, setGoals] = useState(() => initial.map((g) => ({ title: g.title, why: g.why ?? "", evidence: g.evidence ?? [] })));
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
    setGoals((gs) => [...gs, { title: "", why: "", evidence: [] }]);
    focusSoon(titleId(goals.length));
  };
  const empty = goals.some((g) => !g.title.trim());
  const [added, setAdded] = useState<Set<number>>(() => new Set());
  const addSuggestion = (k: number) => {
    const sg = suggestions[k];
    setGoals((gs) => [...gs, { title: sg.title, why: sg.why ?? "", evidence: sg.evidence }]);
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
              <Evidence lines={g.evidence} />
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

/** The dated protocol lines a proposed goal rests on (shown, never stored). */
function Evidence({ lines }: { lines: { date: string; text: string }[] }) {
  if (!lines.length) return null;
  return (
    <details className="text-sm text-ink-3">
      <summary className="cursor-pointer select-none">Underlag ({lines.length})</summary>
      <ul className="mt-1 flex flex-col gap-1 pl-4">
        {lines.map((l, k) => (
          <li key={k}>
            <span className="tabular-nums">{l.date}</span> · {l.text}
          </li>
        ))}
      </ul>
    </details>
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
              <Evidence lines={sg.evidence} />
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
