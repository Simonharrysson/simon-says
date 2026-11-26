import { beforeEach, describe, expect, it } from "vitest";
import { CalendarFake } from "@/e2e/fakes/calendar";
import { calendarApi, CalendarApiError } from "./api";

// The read-only client against the fake Calendar API (the same fake the e2e server runs).

const ROOT = "http://fake.test/";
let fake: CalendarFake;
let user = "anna@e2e.test";
let failWith: number | null = null;

const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  if (failWith) return new Response("{}", { status: failWith });
  const res = fake.handle("GET", url.pathname.replace(/^\/+/, ""), url, auth === `Bearer token-${user}` ? user : "");
  return Response.json(res?.body ?? {}, { status: res?.status ?? 404 });
}) as typeof fetch;

const api = () => calendarApi({ accessToken: async () => `token-${user}`, root: ROOT, fetchImpl });
const HOOK = "c_hookandlook#grupp@group.calendar.google.com";

beforeEach(() => {
  fake = new CalendarFake();
  user = "anna@e2e.test";
  failWith = null;
  fake.seed("anna@e2e.test", { id: "anna@e2e.test", summary: "Anna", primary: true });
  fake.seed("anna@e2e.test", { id: HOOK, summary: "Hook & Look" }, [
    {
      id: "e1",
      summary: "Styrelsemöte",
      start: "2026-12-02T17:00:00Z",
      end: "2026-12-02T18:00:00Z",
      description: "hemligt",
      attendees: [{ email: "erik@example.com", displayName: "Erik", responseStatus: "accepted" }],
    },
    { id: "e0", summary: "Julfest", start: "2026-12-12T00:00:00Z", end: "2026-12-13T00:00:00Z", allDay: true },
    { id: "ex", summary: "Inställt", start: "2026-12-03T17:00:00Z", end: "2026-12-03T18:00:00Z", status: "cancelled" },
  ]);
});

describe("calendarApi", () => {
  it("lists the user's calendars, primary first", async () => {
    expect(await api().listCalendars()).toEqual([
      { id: "anna@e2e.test", name: "Anna", primary: true },
      { id: HOOK, name: "Hook & Look", primary: false },
    ]);
  });

  it("lists timed events of an encoded calendar id, asking only for titles, times and guests", async () => {
    const events = await api().listEvents(HOOK, new Date("2026-12-01T00:00:00Z"), new Date("2026-12-31T00:00:00Z"));
    expect(events).toEqual([
      {
        id: "e1",
        title: "Styrelsemöte",
        start: "2026-12-02T17:00:00.000Z",
        end: "2026-12-02T18:00:00.000Z",
        attendees: [{ email: "erik@example.com", name: "Erik", response: "accepted" }],
      },
    ]);
    const req = fake.requests.find((r) => r.includes("/events?"))!;
    expect(req).toContain(`calendars/${encodeURIComponent(HOOK)}/events`);
    expect(decodeURIComponent(req)).toContain("singleEvents=true");
    expect(decodeURIComponent(req)).not.toContain("description");
  });

  it("gets one event; a gone event or an unreadable calendar is null", async () => {
    expect((await api().getEvent(HOOK, "e1"))?.title).toBe("Styrelsemöte");
    expect(await api().getEvent(HOOK, "nope")).toBeNull();
    user = "olle@e2e.test";
    expect(await api().getEvent(HOOK, "e1")).toBeNull();
    expect(await api().listEvents(HOOK, new Date(0), new Date())).toEqual([]);
  });

  it("pages through a busy calendar", async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      id: `m${i}`,
      summary: i === 299 ? "Styrelsemöte" : "Träning",
      start: new Date(Date.UTC(2027, 0, 1) + i * 3600_000).toISOString(),
      end: new Date(Date.UTC(2027, 0, 1) + i * 3600_000 + 1800_000).toISOString(),
    }));
    fake.seed("anna@e2e.test", { id: HOOK, summary: "Hook & Look" }, many);
    const events = await api().listEvents(HOOK, new Date("2027-01-01T00:00:00Z"), new Date("2027-02-01T00:00:00Z"));
    expect(events).toHaveLength(300);
    expect(events.at(-1)?.title).toBe("Styrelsemöte");
    expect(fake.requests.filter((r) => r.includes("/events?")).length).toBe(2);
  });

  it("throws on a Google error", async () => {
    failWith = 503;
    await expect(api().listCalendars()).rejects.toBeInstanceOf(CalendarApiError);
  });
});
