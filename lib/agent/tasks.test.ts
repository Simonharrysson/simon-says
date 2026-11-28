import { describe, expect, it } from "vitest";
import { myAgentTasks, type HomeMeeting, type HomeNoteRow } from "@/lib/home/tasks";
import { buildOrgMeeting } from "@/lib/home/meeting";
import { agentState, canUpdateAgentTask, isAgentOwner, isAgentTask } from "./tasks";

const row = (over: Partial<HomeNoteRow> = {}): HomeNoteRow => ({
  meeting_id: "m1",
  id: "n1",
  section: "action",
  kind: "task",
  text: "Sammanställ offerterna",
  owner: "Claude",
  due: null,
  locked: false,
  deleted_by_human: false,
  last_rendered_text: null,
  range_name: null,
  position: 0,
  ...over,
});

describe("isAgentOwner", () => {
  it("is the assistant only when the owner text says exactly that", () => {
    for (const o of ["Claude", "claude", " CLAUDE ", "Claude.", "Claude:", "AI", "AI:n", "Simon Says", "simon  says"]) expect(isAgentOwner(o), o).toBe(true);
    for (const o of [null, "", "Claude och Anna", "Anna", "Claudia", "AI-gruppen", "Simon"]) expect(isAgentOwner(o), String(o)).toBe(false);
  });
});

describe("isAgentTask: gentle, never a silent reassignment", () => {
  it("a task owned by Claude", () => {
    expect(isAgentTask(row(), [{ id: "p1", name: "Anna Berg" }])).toBe(true);
  });
  it("not when someone in the org is called that (name, first name or role)", () => {
    expect(isAgentTask(row(), [{ id: "p1", name: "Claude Monet" }])).toBe(false);
    expect(isAgentTask(row({ owner: "AI" }), [{ id: "p1", name: "Anna", role: "AI" }])).toBe(false);
  });
  it("not with an owner link, nor on a line a human edited", () => {
    expect(isAgentTask(row({ owner_person_id: "p1" }), [])).toBe(false);
    expect(isAgentTask(row({ locked: true }), [])).toBe(false);
  });
});

describe("agentState and who may update", () => {
  it("done on the row wins; no status row is open; a half-written done is still in progress", () => {
    expect(agentState(true, undefined)).toEqual({ status: "done", note: null });
    expect(agentState(false, undefined)).toEqual({ status: "open", note: null });
    expect(agentState(false, { status: "blocked", note: "Väntar på priset" })).toEqual({ status: "blocked", note: "Väntar på priset" });
    expect(agentState(false, { status: "done", note: null })).toEqual({ status: "in_progress", note: null });
  });
  it("the assigner (the meeting's runner) or an admin", () => {
    expect(canUpdateAgentTask({ userId: "u1", startedBy: "u1", isAdmin: false })).toBe(true);
    expect(canUpdateAgentTask({ userId: "u2", startedBy: "u1", isAdmin: true })).toBe(true);
    expect(canUpdateAgentTask({ userId: "u2", startedBy: "u1", isAdmin: false })).toBe(false);
    expect(canUpdateAgentTask({ userId: "u2", startedBy: null, isAdmin: false })).toBe(false);
  });
});

const meeting = (over: Partial<HomeMeeting> = {}): HomeMeeting => ({ id: "m1", org_id: "o1", started_at: "2026-11-26T17:00:00Z", status: "done", started_by: "u1", ...over });
const space = { id: "o1", name: "Bolaget", kind: "foretag" as const, isAdmin: false };

describe("Hos Claude in Mina uppgifter (myAgentTasks)", () => {
  it("shows the assigner the tasks their meetings gave Claude, with Claude's progress", () => {
    const tasks = myAgentTasks({
      userId: "u1",
      spaces: [space],
      meetings: [meeting()],
      rows: [row(), row({ id: "n2", owner: "Anna" })],
      people: [{ id: "p1", org_id: "o1", name: "Anna", member_user_id: "u9" }],
      statuses: [{ meeting_id: "m1", item_id: "n1", status: "in_progress", note: "Halvvägs", updated_at: "2026-11-27T10:00:00Z" }],
    });
    expect(tasks).toMatchObject([{ key: "n:m1:n1", text: "Sammanställ offerterna", agent: { status: "in_progress", note: "Halvvägs" } }]);
  });
  it("never to someone who didn't run the meeting", () => {
    expect(myAgentTasks({ userId: "u2", spaces: [space], meetings: [meeting()], rows: [row()], people: [], statuses: [] })).toEqual([]);
  });
});

describe("the meeting page (buildOrgMeeting)", () => {
  const input = (userId: string, role = "member") => ({ userId, org: { id: "o1", name: "Bolaget" }, meeting: meeting(), role, rows: [row()], people: [], statuses: [] });
  it("marks the agent task for everyone, and lets its assigner tick it", () => {
    expect(buildOrgMeeting(input("u1")).tasks[0]).toMatchObject({ agent: { status: "open" }, canTick: true });
    expect(buildOrgMeeting(input("u2")).tasks[0]).toMatchObject({ agent: { status: "open" }, canTick: false });
    expect(buildOrgMeeting(input("u2", "admin")).tasks[0]).toMatchObject({ canTick: true });
  });
});
