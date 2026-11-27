import { describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@/lib/calendar/events";
import { briefsForUser, eligibleSpaces, type BriefDeps, type BriefHistory, type BriefMail, type BriefScope, type BriefSpace, type BriefState, type BriefUser } from "./run";
import { briefEventKey, declinedBy, inBriefWindow } from "./window";

const NOW = new Date("2026-11-27T12:50:00Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const SHARED = "c_board1234@group.calendar.google.com";

const forening: BriefSpace = { id: "f1", name: "Föreningen", kind: "forening", calendarId: SHARED, calendarFilter: "möte" };
const company: BriefSpace = { id: "c1", name: "Bolaget AB", kind: "foretag", calendarId: null, calendarFilter: null };

const user = (over: Partial<BriefUser> = {}): BriefUser => ({
  id: "u1",
  email: "anna@bolaget.se",
  name: "Anna Berg",
  locale: "sv",
  briefForeningar: true,
  spaces: [forening],
  ...over,
});

const event = (id: string, title: string, startMin: number, attendees: CalendarEvent["attendees"] = []): CalendarEvent => ({
  id,
  title,
  start: at(startMin),
  end: at(startMin + 60),
  attendees,
});

const history = (n = 1, orgId = "f1"): BriefHistory => ({
  meetings: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, org_id: orgId, started_at: `2026-11-2${i}T17:00:00Z`, status: "done", is_test: false })),
  rows: [{ meeting_id: "m0", id: "d1", section: "decision", text: "Hackathonet blir 14 feb", owner: null, due: null, locked: false, deleted_by_human: false, last_rendered_text: null, range_name: null, position: 0 }],
  people: [],
  agenda: null,
});

function fakeDeps(opts: { events?: Record<string, CalendarEvent[]>; gate?: "allowed" | "opted_out"; history?: (scope: BriefScope) => BriefHistory; customers?: Record<string, { id: string; name: string }> } = {}) {
  const log = new Map<string, BriefState | "claimed">();
  const mails: { to: string; mail: BriefMail }[] = [];
  const calendarCalls: string[] = [];
  const claims: string[] = [];
  const historyCalls: BriefScope[] = [];
  const deps: BriefDeps = {
    now: () => NOW,
    gate: vi.fn(async () => opts.gate ?? "allowed"),
    calendar: vi.fn(async () => ({
      listEvents: async (calendarId: string) => {
        calendarCalls.push(calendarId);
        return opts.events?.[calendarId] ?? [];
      },
    })),
    ownDomains: async () => ["bolaget.se"],
    customerByDomain: async (_org, domain) => opts.customers?.[domain] ?? null,
    sentKeys: async (userId, keys) => new Set(keys.filter((k) => log.has(`${userId}:${k}`))),
    claim: async (userId, key) => {
      claims.push(key);
      if (log.has(`${userId}:${key}`)) return false;
      log.set(`${userId}:${key}`, "claimed");
      return true;
    },
    finish: async (userId, key, state) => void log.set(`${userId}:${key}`, state),
    history: async (_u, scope) => (historyCalls.push(scope), opts.history ? opts.history(scope) : history(1, scope.org.id)),
    pick: async () => null,
    deliver: async (u, mail) => (mails.push({ to: u.email, mail }), "sent"),
    origin: "https://app.test",
    unsubscribeHref: () => "https://app.test/mejl?t=x",
  };
  return { deps, log, mails, calendarCalls, claims, historyCalls };
}

describe("the timing window", () => {
  it("sends 0–15 minutes before the start, never after it started", () => {
    expect(inBriefWindow({ start: at(10) }, NOW)).toBe(true);
    expect(inBriefWindow({ start: at(15) }, NOW)).toBe(true);
    expect(inBriefWindow({ start: at(15.1) }, NOW)).toBe(false);
    expect(inBriefWindow({ start: at(0) }, NOW)).toBe(false);
    expect(inBriefWindow({ start: at(-5) }, NOW)).toBe(false);
  });

  it("a cron every 5 minutes catches every start exactly in one or more runs, and the sent-log keeps it to one mail", async () => {
    // Starts at every minute over half an hour; runs every 5 minutes.
    for (let s = 1; s <= 30; s++) {
      const start = new Date(NOW.getTime() + s * 60_000);
      const runs = [0, 5, 10, 15, 20, 25, 30].map((m) => new Date(NOW.getTime() + m * 60_000)).filter((r) => inBriefWindow({ start: start.toISOString() }, r));
      expect(runs.length, `start +${s} min`).toBeGreaterThanOrEqual(1);
      // The first run that sees it is 10–15 minutes before (or as early as possible for one starting sooner).
      const lead = (start.getTime() - runs[0].getTime()) / 60_000;
      expect(lead <= 15 && (lead >= 10 || s < 10)).toBe(true);
    }
  });

  it("keys by the event id, hashed", () => {
    expect(briefEventKey("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(briefEventKey("abc")).toBe(briefEventKey("abc"));
    expect(briefEventKey("abc")).not.toContain("abc");
    expect(briefEventKey("abc")).not.toBe(briefEventKey("abd"));
  });

  it("a declined invitation gets no brief", () => {
    expect(declinedBy(event("e", "Möte", 10, [{ email: "anna@bolaget.se", name: null, response: "declined" }]), ["Anna@Bolaget.se"])).toBe(true);
    expect(declinedBy(event("e", "Möte", 10, [{ email: "anna@bolaget.se", name: null, response: "accepted" }]), ["anna@bolaget.se"])).toBe(false);
  });
});

describe("which spaces may brief (default on for Företag, opt-in for föreningar)", () => {
  it("a förening only with a shared calendar and the opt-in; a Företag always (primary for customers)", () => {
    expect(eligibleSpaces(user({ briefForeningar: false })).calendars).toEqual([]);
    expect(eligibleSpaces(user()).calendars).toEqual([forening]);
    expect(eligibleSpaces(user({ spaces: [{ ...forening, calendarId: "anna@gmail.com" }] })).calendars).toEqual([]);
    expect(eligibleSpaces(user({ briefForeningar: false, spaces: [company] })).foretag).toEqual([company]);
    expect(eligibleSpaces(user({ spaces: [{ ...forening, kind: "privat" }] })).calendars).toEqual([]);
  });
});

describe("briefsForUser", () => {
  it("one brief for a förening meeting starting in 10 minutes; a second run sends nothing (idempotent)", async () => {
    const f = fakeDeps({ events: { [SHARED]: [event("e1", "Styrelsemöte", 10)] } });
    expect(await briefsForUser(user(), f.deps)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(f.mails).toHaveLength(1);
    expect(f.mails[0].mail.subject).toBe("Inför Styrelsemöte kl 14.00");
    expect(f.mails[0].mail.text).toContain("Hackathonet blir 14 feb");
    expect(f.mails[0].mail.idempotencyKey).toContain(briefEventKey("e1").slice(0, 32));
    expect(f.log.get(`u1:${briefEventKey("e1")}`)).toBe("sent");
    // Five minutes later the event is still in the window: nothing more.
    expect(await briefsForUser(user(), f.deps)).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(f.mails).toHaveLength(1);
  });

  it("two concurrent runs: only the one that claims the row builds and mails", async () => {
    const f = fakeDeps({ events: { [SHARED]: [event("e1", "Styrelsemöte", 10)] } });
    const [a, b] = await Promise.all([briefsForUser(user(), f.deps), briefsForUser(user(), f.deps)]);
    expect(a.sent + b.sent).toBe(1);
    expect(f.mails).toHaveLength(1);
    expect(f.historyCalls).toHaveLength(1);
  });

  it("no history: the row is claimed and marked skipped, no mail", async () => {
    const f = fakeDeps({ events: { [SHARED]: [event("e1", "Styrelsemöte", 10)] }, history: () => ({ meetings: [], rows: [], people: [], agenda: null }) });
    expect(await briefsForUser(user(), f.deps)).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(f.mails).toEqual([]);
    expect(f.log.get(`u1:${briefEventKey("e1")}`)).toBe("skipped");
  });

  it("not opted in to förening briefs, or the gate says no: the calendar is never read", async () => {
    const off = fakeDeps({ events: { [SHARED]: [event("e1", "Styrelsemöte", 10)] } });
    expect(await briefsForUser(user({ briefForeningar: false }), off.deps)).toMatchObject({ stopped: "no_space", sent: 0 });
    expect(off.deps.calendar).not.toHaveBeenCalled();
    expect(off.deps.gate).not.toHaveBeenCalled();
    const no = fakeDeps({ gate: "opted_out", events: { [SHARED]: [event("e1", "Styrelsemöte", 10)] } });
    expect(await briefsForUser(user(), no.deps)).toMatchObject({ stopped: "gate", sent: 0 });
    expect(no.deps.calendar).not.toHaveBeenCalled();
  });

  it("the förening's title filter and the window apply; started and later meetings wait or are skipped", async () => {
    const f = fakeDeps({
      events: { [SHARED]: [event("lunch", "Lunch", 10), event("later", "Styrelsemöte", 40), event("started", "Medlemsmöte", -5), event("now", "Medlemsmöte", 12)] },
    });
    expect((await briefsForUser(user(), f.deps)).sent).toBe(1);
    expect(f.mails[0].mail.subject).toContain("Medlemsmöte");
  });

  it("a customer meeting in the user's own calendar: by the guests' domain, an existing customer only", async () => {
    const customer = { id: "ctx1", name: "Acme" };
    const meeting = event("e2", "Avstämning", 10, [
      { email: "anna@bolaget.se", name: null, response: "accepted" },
      { email: "kim@acme.se", name: null, response: "accepted" },
    ]);
    const f = fakeDeps({ events: { primary: [meeting] }, customers: { "acme.se": customer } });
    expect((await briefsForUser(user({ spaces: [company], briefForeningar: false }), f.deps)).sent).toBe(1);
    expect(f.historyCalls).toEqual([{ kind: "customer", org: company, customer }]);
    expect(f.mails[0].mail.text).toContain("Acme ses kl 14.00");
    // An unknown domain: nothing (no customer is created).
    const g = fakeDeps({ events: { primary: [{ ...meeting, id: "e3", attendees: [{ email: "x@okand.se", name: null, response: null }] }] } });
    expect((await briefsForUser(user({ spaces: [company] }), g.deps)).sent).toBe(0);
    expect(g.claims).toEqual([]);
    // Only colleagues (own domain): not a customer meeting.
    const h = fakeDeps({ events: { primary: [{ ...meeting, id: "e4", attendees: [{ email: "olle@bolaget.se", name: null, response: null }] }] }, customers: { "bolaget.se": customer } });
    expect((await briefsForUser(user({ spaces: [company] }), h.deps)).sent).toBe(0);
  });

  it("the same meeting on the shared calendar and in the user's own: one brief, as the group's", async () => {
    const both = event("same", "Styrelsemöte", 10, [{ email: "kim@acme.se", name: null, response: null }]);
    const f = fakeDeps({ events: { [SHARED]: [both], primary: [both] }, customers: { "acme.se": { id: "ctx1", name: "Acme" } } });
    expect((await briefsForUser(user({ spaces: [forening, company] }), f.deps)).sent).toBe(1);
    expect(f.historyCalls.map((s) => s.kind)).toEqual(["org"]);
  });

  it("a failed build marks the row failed and is never retried", async () => {
    const f = fakeDeps({
      events: { [SHARED]: [event("e1", "Styrelsemöte", 10)] },
      history: () => {
        throw new Error("db down");
      },
    });
    expect(await briefsForUser(user(), f.deps)).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(f.log.get(`u1:${briefEventKey("e1")}`)).toBe("failed");
    expect((await briefsForUser(user(), f.deps)).failed).toBe(0);
  });

  it("Claude is asked only with more than three decisions, and only picks (unknown ids are ignored)", async () => {
    const many: BriefHistory = {
      ...history(),
      rows: ["A", "B", "C", "D", "E"].map((t, i) => ({ ...history().rows[0], id: `d${i}`, text: `Beslut ${t}`, position: i })),
    };
    const f = fakeDeps({ events: { [SHARED]: [event("e1", "Budgetmöte", 10)] }, history: () => many });
    const pick = vi.fn(async () => ["d5", "zz", "d4"]);
    f.deps.pick = pick;
    await briefsForUser(user(), f.deps);
    expect(pick).toHaveBeenCalledOnce();
    const text = f.mails[0].mail.text;
    const decisions = text.split("BESLUT ATT HA I HUVUDET\n")[1].split("\n\n")[0];
    expect(decisions.split("\n").map((l) => l.replace(/ \(.*$/, ""))).toEqual(["- Beslut E", "- Beslut D", "- Beslut A"]);
    // Three or fewer: no call.
    const g = fakeDeps({ events: { [SHARED]: [event("e1", "Budgetmöte", 10)] } });
    const none = vi.fn(async () => null);
    g.deps.pick = none;
    await briefsForUser(user(), g.deps);
    expect(none).not.toHaveBeenCalled();
  });
});
