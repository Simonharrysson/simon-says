"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProgressFill } from "@/components/motion/ProgressFill";
import { Banner } from "@/components/ui/Banner";
import { Button, Spinner } from "@/components/ui/button";
import { IconAlert, IconCheck, IconClock, IconRefresh } from "@/components/ui/icons";
import { formatUsd } from "@/lib/history/limits";
import {
  DIRECT_CONCURRENCY,
  formatMinutesLeft,
  isOpen,
  itemLabel,
  jobProgress,
  reasonMessage,
  retryable,
  STALE_READING_MS,
  tally,
  type ItemView,
  type JobProposal,
  type JobView,
} from "@/lib/history/progress";
import { cn } from "@/lib/utils";

// The protocol import's one progress view (0036 jobs). Calm on purpose: one line with a number
// ("12 av 40 klara · ca 6 min kvar"), a bar, one sentence on what is happening and whether the
// page may be closed, and a list with one row per meeting. Never an open-ended "working on it":
// before there is throughput to estimate from, the line says so in words.
//
// Direct (≤ 20 meetings): this component reads the meetings, DIRECT_CONCURRENCY at a time, one
// request each; Anthropic's 429/529 come back as `busy` and the meeting is retried after a pause
// (2 s, 5 s, 12 s, 30 s + jitter). It pauses if the page closes and resumes from the database.
// Batch: the server and the cron do the work; this view only asks for the state (every 15 s).

export interface FinishedImport {
  imported: number;
  failed: number;
  stopped: string | null;
  /** Meetings whose date came from the Doc's creation date (the admin may correct them). */
  fileDated: { protocolId: string; label: string; date: string }[];
}

const BACKOFF_MS = [2_000, 5_000, 12_000, 30_000];
const POLL_MS = 15_000;
/** Errors that stop the rest of a direct import: no point in trying the others now. */
const STOPPING = new Set(["google_auth_lost", "rate_limited", "spend"]);

export function ImportProgress({
  orgId,
  initial,
  autoRun = false,
  names: pickedNames,
  now: fixedNow,
  onFinished,
  onProposal,
  onClose,
}: {
  orgId: string;
  initial: JobView;
  /** Direct: start reading at once (the admin just confirmed). On a revisit they press "Fortsätt". */
  autoRun?: boolean;
  /** Drive file names of the pick (docId → name), kept in this browser only. */
  names?: Record<string, string>;
  /** /design only: a fixed clock, and no requests. */
  now?: number;
  /** Direct import finished (or a batch without a stored proposal): continue to the goals as before. */
  onFinished: (result: FinishedImport) => void;
  onProposal: (proposal: JobProposal, result: FinishedImport) => void;
  onClose: () => void;
}) {
  const demo = fixedNow !== undefined;
  const tr = useTranslations("importProgress");
  const locale = useLocale();
  const [job, setJob] = useState<JobView>(initial);
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState<"cancel" | "close" | number | null>(null);
  const [tick, setTick] = useState(() => fixedNow ?? Date.now());
  const pool = useRef(false);
  const [names, setNames] = useState<Record<string, string>>(pickedNames ?? {});

  // File names live in this browser only (never stored on the server): remember them per import.
  useEffect(() => {
    const key = `simonsays:import-names:${initial.id}`;
    try {
      if (pickedNames && Object.keys(pickedNames).length) window.localStorage.setItem(key, JSON.stringify(pickedNames));
      else {
        const saved = JSON.parse(window.localStorage.getItem(key) ?? "null") as Record<string, string> | null;
        if (saved && typeof saved === "object") setNames(saved);
      }
    } catch {
      // private mode or blocked storage: the neutral labels are shown
    }
  }, [initial.id, pickedNames]);

  // The clock for "ca X min kvar" (every 10 s is plenty).
  useEffect(() => {
    if (demo) return;
    const t = setInterval(() => setTick(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [demo]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/history/jobs/${job.id}`, { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as { job?: JobView } | null;
      if (res.ok && json?.job) {
        setJob(json.job);
        setNotice(null);
      }
    } catch {
      setNotice(tr("unreachable"));
    }
  }, [orgId, job.id, tr]);

  // Batch (and a digest in progress): ask for the state now and then.
  useEffect(() => {
    if (demo || job.mode !== "batch" || !isOpen(job.status)) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [demo, job.mode, job.status, refresh]);

  /** One meeting through the direct path. Returns a stopping message, or null. */
  const runItem = useCallback(
    async (itemId: number): Promise<string | null> => {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        let json: { job?: JobView | null; error?: string; message?: string } | null;
        try {
          res = await fetch(`/api/orgs/${orgId}/history/jobs/${job.id}/items/${itemId}`, { method: "POST" });
          json = (await res.json().catch(() => null)) as typeof json;
        } catch {
          setJob((j) => ({ ...j, items: j.items.map((i) => (i.id === itemId ? { ...i, state: "failed", reason: "unreachable" } : i)) }));
          return null;
        }
        if (json?.job) setJob(json.job);
        if (res.ok) return null;
        if (json?.error === "busy" && attempt < BACKOFF_MS.length) {
          const wait = BACKOFF_MS[attempt] + Math.round(Math.random() * 1000);
          setNotice(tr("busy", { seconds: Math.ceil(wait / 1000) }));
          await new Promise((r) => setTimeout(r, wait));
          setNotice(null);
          continue;
        }
        if (json?.error && STOPPING.has(json.error)) return json.message ?? tr("stopped");
        return null;
      }
    },
    [orgId, job.id, tr],
  );

  /** Reads every waiting meeting, a few at a time. */
  const runPool = useCallback(
    async (ids: number[]) => {
      if (pool.current) return;
      pool.current = true;
      setRunning(true);
      setStopped(null);
      const queue = [...ids];
      let stop: string | null = null;
      const worker = async () => {
        while (queue.length && !stop) {
          const id = queue.shift()!;
          setJob((j) => ({ ...j, items: j.items.map((i) => (i.id === id ? { ...i, state: "reading", reason: null, startedAt: new Date().toISOString() } : i)) }));
          stop = (await runItem(id)) ?? stop;
        }
      };
      await Promise.all(Array.from({ length: Math.min(DIRECT_CONCURRENCY, queue.length) }, worker));
      pool.current = false;
      setRunning(false);
      if (stop) setStopped(stop);
      await refresh();
    },
    [runItem, refresh],
  );

  const runnable = (j: JobView) =>
    j.items.filter((i) => i.state === "waiting" || (i.state === "reading" && (!i.startedAt || Date.now() - Date.parse(i.startedAt) > STALE_READING_MS))).map((i) => i.id);

  const started = useRef(false);
  useEffect(() => {
    if (demo || started.current || !autoRun || job.mode !== "direct" || job.status !== "running") return;
    started.current = true;
    void runPool(runnable(job));
  }, [demo, autoRun, job, runPool]);

  const cancel = async () => {
    setBusy("cancel");
    try {
      const res = await fetch(`/api/orgs/${orgId}/history/jobs/${job.id}/cancel`, { method: "POST" });
      const json = (await res.json().catch(() => null)) as { job?: JobView; message?: string } | null;
      if (json?.job) setJob(json.job);
      else if (!res.ok) setNotice(json?.message ?? tr("cancelFailed"));
    } catch {
      setNotice(tr("offline"));
    } finally {
      setBusy(null);
      setConfirmCancel(false);
    }
  };

  /** Continuing to the goals closes the import on the Översikt (no second proposal on revisit). */
  const markSeen = () => void fetch(`/api/orgs/${orgId}/history/jobs/${job.id}/seen`, { method: "POST" }).catch(() => null);

  const close = async () => {
    setBusy("close");
    await fetch(`/api/orgs/${orgId}/history/jobs/${job.id}/seen`, { method: "POST" }).catch(() => null);
    setBusy(null);
    onClose();
  };

  const retry = async (itemId: number) => {
    setBusy(itemId);
    setJob((j) => ({ ...j, items: j.items.map((i) => (i.id === itemId ? { ...i, state: "reading", reason: null, startedAt: new Date().toISOString() } : i)) }));
    const stop = await runItem(itemId);
    if (stop) setStopped(stop);
    setBusy(null);
  };

  const t = tally(job.items);
  const p = jobProgress(job, tick);
  const open = isOpen(job.status);
  const pct = p.total ? Math.round((p.finished / p.total) * 100) : 100;
  const isRunning = running || (demo && autoRun);
  const pausedDirect = job.mode === "direct" && job.status === "running" && !isRunning && runnable(job).length > 0;
  const result: FinishedImport = {
    imported: t.done,
    failed: t.failed,
    stopped,
    fileDated: job.items.flatMap((i) =>
      i.state === "done" && i.dateFrom === "file" && i.protocolId && i.date ? [{ protocolId: i.protocolId, label: itemLabel({ ...i, date: null }, names, locale), date: i.date }] : [],
    ),
  };

  // ------------------------------------------------------------------ the headline
  let headline: string;
  let detail: string;
  if (job.status === "digesting") {
    headline = tr("digestingHeadline", { done: t.done, total: p.total, failed: t.failed ? tr("failedSuffix", { count: t.failed }) : "" });
    detail = tr("digestingDetail");
  } else if (job.status === "canceling") {
    headline = tr("cancelingHeadline", { finished: p.finished, total: p.total });
    detail = tr("cancelingDetail");
  } else if (open) {
    const eta =
      p.minutesLeft !== null
        ? formatMinutesLeft(p.minutesLeft, locale)
        : job.mode === "batch"
          ? p.noEstimate === "too_early"
            ? tr("etaSoon")
            : tr("etaNone")
          : tr("etaFirst");
    headline = tr("openHeadline", {
      finished: p.finished,
      total: p.total,
      failed: t.failed ? tr("failedSuffix", { count: t.failed }) : "",
      eta: pausedDirect ? tr("paused") : eta,
    });
    detail =
      job.mode === "batch"
        ? `${p.noEstimate === "none_finished" ? tr("batchStarted") : tr("batchReading")}${tr("batchClose")}`
        : pausedDirect
          ? tr("pausedDetail")
          : tr("directDetail", { count: Math.min(DIRECT_CONCURRENCY, p.total) });
  } else {
    const parts = [
      tr("partImported", { count: t.done }),
      t.skipped ? tr("partSkipped", { count: t.skipped }) : "",
      t.failed ? tr("partFailed", { count: t.failed }) : "",
    ].filter(Boolean);
    headline =
      job.status === "canceled"
        ? tr("canceledHeadline", { parts: parts.join(" · ") })
        : job.status === "failed"
          ? tr("failedHeadline")
          : tr("doneHeadline", { parts: parts.join(" · ") });
    detail =
      job.status === "failed"
        ? tr("failedDetail")
        : job.mode === "batch" && job.costUsd > 0
          ? tr("cost", { cost: formatUsd(job.costUsd, locale).replace("≈ ", "") })
          : "";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="font-medium tabular-nums" role="status" aria-live="polite">
          {headline}
        </p>
        <div
          className="h-2 w-full max-w-[28rem] overflow-hidden rounded-full bg-sunk"
          role="progressbar"
          aria-label={tr("progressLabel")}
          aria-valuemin={0}
          aria-valuemax={p.total}
          aria-valuenow={p.finished}
        >
          <ProgressFill pct={pct} className="h-full w-full rounded-full bg-ink-2" />
        </div>
        {detail && <p className="text-sm text-ink-2 max-w-[68ch]">{detail}</p>}
      </div>

      {notice && (
        <Banner tone="warning" live={false}>
          {notice}
        </Banner>
      )}
      {stopped && <Banner tone="danger">{stopped}</Banner>}
      {job.status === "done" && job.mode === "batch" && job.proposalError && (
        <Banner tone="warning" live={false}>
          {job.proposalError === "too_few" ? tr("tooFew") : tr("proposalFailed")}
        </Banner>
      )}
      {job.proposal && job.proposal.trimmed > 0 && (
        <p className="text-sm text-ink-3 max-w-[68ch]">
          {tr("trimmed", { meetings: job.proposal.meetings, trimmed: job.proposal.trimmed })}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {pausedDirect && (
          <Button variant="primary" onClick={() => runPool(runnable(job))}>
            {tr("continue")}
          </Button>
        )}
        {!open && job.status !== "failed" && job.proposal && (
          <Button variant="primary" onClick={() => {
              markSeen();
              onProposal(job.proposal!, result);
            }}>
            {tr("seeProposal")}
          </Button>
        )}
        {!open && job.status === "done" && !job.proposal && t.done > 0 && (
          <Button
            variant="primary"
            onClick={() => {
              markSeen();
              onFinished(result);
            }}
          >
            {job.mode === "batch" ? tr("propose") : tr("toGoals")}
          </Button>
        )}
        {job.status === "running" &&
          (confirmCancel ? (
            <span className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
              <span>{job.mode === "batch" ? tr("cancelBatch") : tr("cancelDirect")}</span>
              <Button variant="danger-ghost" size="sm" loading={busy === "cancel"} onClick={cancel}>
                {tr("cancelImport")}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy === "cancel"} onClick={() => setConfirmCancel(false)}>
                {tr("keepReading")}
              </Button>
            </span>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmCancel(true)}>
              {tr("cancelEllipsis")}
            </Button>
          ))}
        {!open && (
          <Button variant="ghost" loading={busy === "close"} onClick={close}>
            {tr("close")}
          </Button>
        )}
      </div>

      <ol className="max-h-[26rem] overflow-y-auto overscroll-contain rounded-lg bg-sunk/60" aria-label={tr("listLabel")}>
        {job.items.map((i) => (
          <Row
            key={i.id}
            item={i}
            label={itemLabel(i, names, locale)}
            batchRunning={job.mode === "batch" && open}
            canRetry={retryable(i.state, i.reason) && !(job.mode === "batch" && open) && !isRunning}
            retrying={busy === i.id}
            onRetry={() => retry(i.id)}
          />
        ))}
      </ol>
    </div>
  );
}

function Row({
  item: i,
  label,
  batchRunning,
  canRetry,
  retrying,
  onRetry,
}: {
  item: ItemView;
  label: string;
  batchRunning: boolean;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const tr = useTranslations("importProgress");
  const locale = useLocale();
  const why = i.state === "skipped" || i.state === "failed" ? reasonMessage(i.reason, locale) : null;
  const stateText = i.state === "reading" && batchRunning ? tr("atClaude") : tr(`rowState.${i.state}`);
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-line px-3 py-2 first:border-t-0">
      <span className="mt-0.5 grid size-5 flex-none place-content-center text-ink-3" aria-hidden>
        {i.state === "reading" ? (
          batchRunning ? <IconClock size={16} /> : <Spinner />
        ) : i.state === "done" ? (
          <IconCheck size={16} strokeWidth={2.25} className="text-green" />
        ) : i.state === "failed" ? (
          <IconAlert size={16} className="text-red" />
        ) : null}
      </span>
      <span className="flex min-w-[min(12rem,100%)] flex-1 flex-col">
        <span className={cn("text-sm wrap-anywhere", (i.state === "waiting" || i.state === "skipped") && "text-ink-3")}>{label}</span>
        {why && <span className="text-xs text-ink-3">{why}</span>}
        {i.state === "done" && i.dateFrom === "file" && <span className="text-xs text-ink-3">{tr("dateFromFile")}</span>}
      </span>
      <span className="ml-auto flex flex-none items-center gap-2">
        {canRetry && (
          <Button variant="ghost" size="sm" icon={<IconRefresh size={14} />} loading={retrying} onClick={onRetry}>
            {tr("tryAgain")}
          </Button>
        )}
        <span className={cn("text-xs", i.state === "done" ? "text-green" : i.state === "failed" ? "text-red" : "text-ink-3")}>{stateText}</span>
      </span>
    </li>
  );
}
