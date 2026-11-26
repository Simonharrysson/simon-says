import type { TaskStatus } from "./summary";

// "Sedan sist": the context's tasks that were open before this recording, each marked klart /
// öppen / inte nämnd from the summary's verdicts. Pure: the sender, the pages and the e-mail use it.

export interface OpenTask {
  id: string;
  text: string;
  owner: string | null;
  created_at: string;
}

export interface SinceLastItem {
  taskId: string;
  text: string;
  owner: string | null;
  status: TaskStatus;
}

/** Short ids for the prompt ("t1", "t2", …), oldest task first. */
export function taskKeys<T extends OpenTask>(tasks: T[]): { key: string; task: T }[] {
  return [...tasks].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).map((task, i) => ({ key: `t${i + 1}`, task }));
}

/**
 * Every open task once, in the prompt's order, with Claude's verdict for its key; a task Claude
 * left out is "not_mentioned", a key Claude made up is dropped, and when a key was answered twice
 * the first answer counts.
 */
export function sinceLast<T extends OpenTask>(keyed: { key: string; task: T }[], verdicts: { id: string; status: TaskStatus }[]): SinceLastItem[] {
  const byKey = new Map<string, TaskStatus>();
  for (const v of verdicts) if (!byKey.has(v.id)) byKey.set(v.id, v.status);
  return keyed.map(({ key, task }) => ({ taskId: task.id, text: task.text, owner: task.owner, status: byKey.get(key) ?? "not_mentioned" }));
}

/** Tasks the recording says are done: they are ticked in the context's list. */
export const doneTaskIds = (items: SinceLastItem[]) => items.filter((i) => i.status === "done").map((i) => i.taskId);

/** Done first, then still open, then not mentioned (how the e-mail and page list them). */
export function sinceLastOrder(items: SinceLastItem[]): SinceLastItem[] {
  const rank: Record<TaskStatus, number> = { done: 0, open: 1, not_mentioned: 2 };
  return items.map((item, i) => ({ item, i })).sort((a, b) => rank[a.item.status] - rank[b.item.status] || a.i - b.i).map((x) => x.item);
}
