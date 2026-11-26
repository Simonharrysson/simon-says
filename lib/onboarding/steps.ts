// "Kom igång" (todo #5): the onboarding's six steps and its progress. Pure; shared by the server
// page, the wizard and the förening page's card.

export const STEP_IDS = ["namn", "styrelsen", "mapp", "format", "protokoll", "roster"] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEPS: { id: StepId; title: string; short: string }[] = [
  { id: "namn", title: "Namn och logga", short: "Logga" },
  { id: "styrelsen", title: "Styrelsen", short: "Styrelsen" },
  { id: "mapp", title: "Mötesmapp", short: "Mötesmapp" },
  { id: "format", title: "Så brukar ni ha möten", short: "Möten" },
  { id: "protokoll", title: "Era tidigare möten", short: "Tidigare möten" },
  { id: "roster", title: "Röster", short: "Röster" },
];

export const isStepId = (v: unknown): v is StepId => typeof v === "string" && (STEP_IDS as readonly string[]).includes(v);

export interface OnboardingState {
  done: StepId[];
  skipped: StepId[];
  completedAt: string | null;
  dismissedAt: string | null;
}

/** Steps the admin has passed (done or skipped), in step order. */
export function handled(s: Pick<OnboardingState, "done" | "skipped">): StepId[] {
  return STEP_IDS.filter((id) => s.done.includes(id) || s.skipped.includes(id));
}

/** The step to resume at: the first one not handled (null when every step is). */
export function resumeStep(s: Pick<OnboardingState, "done" | "skipped">): StepId | null {
  return STEP_IDS.find((id) => !s.done.includes(id) && !s.skipped.includes(id)) ?? null;
}

/** 1-based step number for the URL (`?steg=2`), and back. Out of range → null. */
export const stepNumber = (id: StepId) => STEP_IDS.indexOf(id) + 1;
export function stepFromNumber(n: unknown): StepId | null {
  const i = Number(n);
  return Number.isInteger(i) && i >= 1 && i <= STEP_IDS.length ? STEP_IDS[i - 1] : null;
}

/** The state after completing (`done`) or skipping a step. Done wins over an earlier skip. */
export function markStep(s: OnboardingState, id: StepId, how: "done" | "skipped", now: string): OnboardingState {
  const done = how === "done" ? uniq([...s.done, id]) : s.done;
  const skipped = how === "done" ? s.skipped.filter((x) => x !== id) : s.done.includes(id) ? s.skipped : uniq([...s.skipped, id]);
  const next = { ...s, done: order(done), skipped: order(skipped) };
  return { ...next, completedAt: s.completedAt ?? (resumeStep(next) === null ? now : null) };
}

/** The "Kom igång" card shows until every step is handled or an admin hides it. */
export const showCard = (s: OnboardingState | null): s is OnboardingState => s !== null && !s.completedAt && !s.dismissedAt;

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const order = (xs: StepId[]) => STEP_IDS.filter((id) => xs.includes(id));
