import { beforeEach, describe, expect, it, vi } from "vitest";

// The Företag start plan (0050, security review): nothing from the calendar attaches by itself.
// The CEO's Privat möte with Kim on the invite (no answer yet): without the CEO's tick, Kim is no
// attendee, so Kim never sees it.

const m = vi.hoisted(() => ({
  event: null as null | { id: string; title: string; guests: { email: string; name: string | null; response: string | null }[] },
  audience: vi.fn(async (..._a: unknown[]) => ["ceo"]),
  customer: vi.fn(async (..._a: unknown[]) => "cust1"),
}));
vi.mock("@/lib/calendar/load", () => ({ foretagEventById: vi.fn(async () => m.event) }));
vi.mock("@/lib/db/foretag", () => ({ audienceIds: m.audience, customerForDomain: m.customer }));
vi.mock("@/lib/db/members", () => ({
  orgMemberList: async () => [
    { userId: "ceo", email: "vd@bolaget.se", role: "admin" },
    { userId: "kim", email: "kim@bolaget.se", role: "member" },
    { userId: "eva", email: "eva@bolaget.se", role: "member" },
  ],
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { id: "g1" }, error: null }) }) }) }) }) }) }),
}));
const { planForetagStart } = await import("./start");

const base = { orgId: "org", user: { id: "ceo", email: "vd@bolaget.se" }, groupId: null, readCalendar: true };

beforeEach(() => {
  m.event = {
    id: "ev1",
    title: "Löner 2027",
    guests: [
      { email: "vd@bolaget.se", name: "VD", response: "accepted" },
      { email: "kim@bolaget.se", name: "Kim", response: "needsAction" },
      { email: "anna@acme.se", name: "Anna", response: "accepted" },
    ],
  };
  m.audience.mockClear();
  m.customer.mockClear();
});

const attendees = (r: Awaited<ReturnType<typeof planForetagStart>>) => (r.ok ? r.plan.attendees.map((a) => a.userId) : null);

describe("planForetagStart: attendees only by the starter's confirmation", () => {
  it("no confirmed event: only the starter, no title, no customer (Kim stays out of the CEO's Privat möte)", async () => {
    const r = await planForetagStart({ ...base, private: true });
    expect(attendees(r)).toEqual(["ceo"]);
    expect(r.ok && r.plan.eventTitle).toBeNull();
    expect(r.ok && r.plan.customerId).toBeNull();
    expect(m.audience).toHaveBeenCalledWith("org", null, true, "ceo", ["ceo"]);
  });

  it("a confirmed event but Kim not ticked: Kim is no attendee", async () => {
    const r = await planForetagStart({ ...base, private: true, calendarEventId: "ev1", attendeeIds: [] });
    expect(attendees(r)).toEqual(["ceo"]);
    expect(r.ok && r.plan.eventTitle).toBe("Löner 2027");
  });

  it("only ticked colleagues who are on the event's guest list attend", async () => {
    const r = await planForetagStart({ ...base, private: false, calendarEventId: "ev1", attendeeIds: ["kim", "eva"] });
    expect(attendees(r)).toEqual(["ceo", "kim"]);
  });

  it("a colleague who declined the invite never attends, even ticked", async () => {
    m.event!.guests.push({ email: "eva@bolaget.se", name: "Eva", response: "declined" });
    const r = await planForetagStart({ ...base, private: true, calendarEventId: "ev1", attendeeIds: ["kim", "eva"] });
    expect(attendees(r)).toEqual(["ceo", "kim"]);
  });

  it("a Privat möte never gets a customer; another meeting gets the confirmed event's", async () => {
    await planForetagStart({ ...base, private: true, calendarEventId: "ev1", attendeeIds: [] });
    expect(m.customer).not.toHaveBeenCalled();
    const r = await planForetagStart({ ...base, private: false, calendarEventId: "ev1", attendeeIds: [] });
    expect(m.customer).toHaveBeenCalledWith("org", "acme.se", "Acme");
    expect(r.ok && r.plan.customerId).toBe("cust1");
  });

  it("an event that is gone or not now: nothing attached", async () => {
    m.event = null;
    const r = await planForetagStart({ ...base, private: false, calendarEventId: "ev1", attendeeIds: ["kim"] });
    expect(attendees(r)).toEqual(["ceo"]);
    expect(m.customer).not.toHaveBeenCalled();
  });
});
