import type { ItemView, JobView } from "@/lib/history/progress";
import { OVERVIEW_NOW } from "./overview-demo";

// /design: the protocol import's progress states (0036), with fake, illustrative data only.

const now = OVERVIEW_NOW.getTime();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
export const IMPORT_DEMO_NOW = now;

const months = ["jan", "feb", "mars", "april", "maj", "juni", "aug", "sep", "okt", "nov"];
const label = (k: number) => `Styrelsemöte ${(k % 27) + 1} ${months[k % months.length]} ${2023 + Math.floor(k / 40)}`;

function items(n: number, state: (k: number) => Partial<ItemView>): ItemView[] {
  return Array.from({ length: n }, (_, k) => ({
    id: k + 1,
    label: label(k),
    state: "waiting" as const,
    reason: null,
    protocolId: null,
    date: null,
    dateFrom: null,
    startedAt: null,
    finishedAt: null,
    ...state(k),
  }));
}

const base = { createdAt: ago(3), endedAt: null, finishedAt: null, estimateUsd: 0, costUsd: 0, counts: null, proposal: null, proposalError: null, failure: null };

/** Few meetings, read directly: 3 klara, 2 läses, 3 väntar, one skipped before sending. */
export const smallRunning: JobView = {
  ...base,
  id: "demo-small",
  mode: "direct",
  status: "running",
  total: 9,
  createdAt: ago(2),
  items: items(9, (k) =>
    k === 8
      ? { label: "Mötesanteckningar – Simon Says", state: "skipped", reason: "own_doc", finishedAt: ago(2) }
      : k < 3
        ? { state: "done", startedAt: ago(1.8 - k * 0.3), finishedAt: ago(1.2 - k * 0.3), protocolId: `p${k}`, date: "2024-03-0" + (k + 1), dateFrom: "doc" }
        : k < 5
          ? { state: "reading", startedAt: ago(0.3) }
          : {},
  ),
};

/** Many meetings, one batch, just sent: no throughput yet (the view says so, with a number). */
export const largeStarted: JobView = {
  ...base,
  id: "demo-large-start",
  mode: "batch",
  status: "running",
  total: 120,
  createdAt: ago(1),
  estimateUsd: 3.1,
  counts: { processing: 120, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
  items: items(120, () => ({ state: "reading", startedAt: ago(1) })),
};

/** The same batch 24 minutes in: Anthropic's counts move, an estimate from them. */
export const largeRunning: JobView = {
  ...largeStarted,
  id: "demo-large-run",
  createdAt: ago(24),
  counts: { processing: 70, succeeded: 49, errored: 1, canceled: 0, expired: 0 },
  items: items(120, () => ({ state: "reading", startedAt: ago(24) })),
};

/** A direct import that finished with failures and a skipped Doc: "Försök igen" per row. */
export const smallFailed: JobView = {
  ...smallRunning,
  id: "demo-failed",
  status: "done",
  finishedAt: ago(1),
  items: items(9, (k) =>
    k === 8
      ? { label: "Mötesanteckningar – Simon Says", state: "skipped", reason: "own_doc", finishedAt: ago(5) }
      : k === 3
        ? { state: "failed", reason: "no_date", startedAt: ago(4), finishedAt: ago(3) }
        : k === 6
          ? { state: "failed", reason: "error", startedAt: ago(3), finishedAt: ago(2) }
          : { state: "done", startedAt: ago(4), finishedAt: ago(3), protocolId: `p${k}`, date: "2024-05-1" + k, dateFrom: k === 5 ? "file" : "doc" },
  ),
};

/** A batch that ended and whose goals the cron proposed. */
export const largeDone: JobView = {
  ...largeStarted,
  id: "demo-done",
  status: "done",
  createdAt: ago(70),
  endedAt: ago(12),
  finishedAt: ago(8),
  costUsd: 2.64,
  counts: { processing: 0, succeeded: 118, errored: 2, canceled: 0, expired: 0 },
  items: items(120, (k) =>
    k === 17
      ? { state: "failed", reason: "refusal", startedAt: ago(70), finishedAt: ago(12) }
      : k === 64
        ? { state: "failed", reason: "error", startedAt: ago(70), finishedAt: ago(12) }
        : { state: "done", startedAt: ago(70), finishedAt: ago(12), protocolId: `p${k}`, date: "2024-01-01", dateFrom: "doc" },
  ),
  proposal: {
    goals: [
      { title: "Spelkafé varje fredag", why: "Beslutat i mars 2024 och tillbaka på varje möte sedan dess." },
      { title: "60 medlemmar till jul", why: "52 medlemmar i november; målet sattes i september." },
    ],
    explanation: "Simon Says läste 120 protokoll och era 11 möten och hittade 2 mål som pågår, 3 som är nådda och 1 som har runnit ut i sanden.",
    others: [],
    meetings: 131,
    trimmed: 0,
  },
};

/** Every result saved, the digest is running (the cron). */
export const largeDigesting: JobView = { ...largeDone, id: "demo-digesting", status: "digesting", finishedAt: null, proposal: null };
