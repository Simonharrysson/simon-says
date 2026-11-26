import { describe, expect, it } from "vitest";
import { doneTaskIds, sinceLast, sinceLastOrder, taskKeys, type OpenTask } from "./since-last";

const task = (id: string, day: string, owner: string | null = null): OpenTask => ({
  id,
  text: `Uppgift ${id}`,
  owner,
  created_at: `2026-11-${day}T10:00:00Z`,
});

describe("Sedan sist", () => {
  const keyed = taskKeys([task("c", "20"), task("a", "10", "Anna"), task("b", "15")]);

  it("keys the open tasks oldest first", () => {
    expect(keyed.map((k) => [k.key, k.task.id])).toEqual([
      ["t1", "a"],
      ["t2", "b"],
      ["t3", "c"],
    ]);
  });

  it("marks each open task klart / öppen / inte nämnd; a task Claude skipped is inte nämnd", () => {
    const items = sinceLast(keyed, [
      { id: "t2", status: "done" },
      { id: "t1", status: "open" },
    ]);
    expect(items.map((i) => [i.taskId, i.status])).toEqual([
      ["a", "open"],
      ["b", "done"],
      ["c", "not_mentioned"],
    ]);
    expect(items[0].owner).toBe("Anna");
    expect(doneTaskIds(items)).toEqual(["b"]);
  });

  it("drops made-up ids and keeps the first verdict for a repeated id", () => {
    const items = sinceLast(keyed, [
      { id: "t9", status: "done" },
      { id: "t3", status: "open" },
      { id: "t3", status: "done" },
    ]);
    expect(items).toHaveLength(3);
    expect(items.find((i) => i.taskId === "c")?.status).toBe("open");
    expect(doneTaskIds(items)).toEqual([]);
  });

  it("no open tasks: nothing since last time", () => {
    expect(sinceLast([], [{ id: "t1", status: "done" }])).toEqual([]);
  });

  it("lists done first, then open, then not mentioned, stable within each", () => {
    const items = sinceLast(keyed, [
      { id: "t1", status: "not_mentioned" },
      { id: "t2", status: "open" },
      { id: "t3", status: "done" },
    ]);
    expect(sinceLastOrder(items).map((i) => i.taskId)).toEqual(["c", "b", "a"]);
  });
});
