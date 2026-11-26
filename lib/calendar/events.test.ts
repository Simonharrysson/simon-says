import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  eventForNow,
  isNow,
  matchAttendees,
  matchesFilter,
  parseEvent,
  parseMeetingEvent,
  stockholmDateTime,
  upcomingEvents,
  type CalendarEvent,
} from "./events";

const ev = (id: string, start: string, end: string, title = "Styrelsemöte"): CalendarEvent => ({ id, title, start, end, attendees: [] });

describe("cleanTitle", () => {
  it("keeps one line without control characters, capped", () => {
    expect(cleanTitle("  Styrelse\nmöte\t\u0007 ")).toBe("Styrelse möte");
    expect(cleanTitle(42)).toBe("");
    const long = cleanTitle("a".repeat(300));
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("parseEvent", () => {
  it("keeps timed events with their guests, drops rooms", () => {
    const e = parseEvent({
      id: "e1",
      summary: "Möte",
      start: { dateTime: "2026-12-02T18:00:00+01:00" },
      end: { dateTime: "2026-12-02T19:00:00+01:00" },
      attendees: [
        { email: "Anna@Example.com", displayName: "Anna Berg", responseStatus: "accepted" },
        { email: "rum@resource.calendar.google.com", resource: true },
      ],
    });
    expect(e).toEqual({
      id: "e1",
      title: "Möte",
      start: "2026-12-02T17:00:00.000Z",
      end: "2026-12-02T18:00:00.000Z",
      attendees: [{ email: "anna@example.com", name: "Anna Berg", response: "accepted" }],
    });
  });
  it("skips cancelled and all-day events", () => {
    expect(parseEvent({ id: "x", status: "cancelled", start: { dateTime: "2026-12-02T18:00:00Z" }, end: { dateTime: "2026-12-02T19:00:00Z" } })).toBeNull();
    expect(parseEvent({ id: "x", start: { date: "2026-12-02" }, end: { date: "2026-12-03" } })).toBeNull();
    expect(parseEvent(null)).toBeNull();
  });
});

describe("filter, now and upcoming", () => {
  const now = new Date("2026-12-02T17:00:00Z");
  it("matches the filter case-insensitively; empty passes everything", () => {
    expect(matchesFilter("Styrelsemöte", "MÖTE")).toBe(true);
    expect(matchesFilter("Lunch", "möte")).toBe(false);
    expect(matchesFilter("Lunch", "")).toBe(true);
    expect(matchesFilter("Lunch", null)).toBe(true);
  });
  it("is now from 30 minutes before the start until the end", () => {
    expect(isNow(ev("a", "2026-12-02T17:29:00Z", "2026-12-02T18:00:00Z"), now)).toBe(true);
    expect(isNow(ev("a", "2026-12-02T17:31:00Z", "2026-12-02T18:00:00Z"), now)).toBe(false);
    expect(isNow(ev("a", "2026-12-02T16:00:00Z", "2026-12-02T17:00:00Z"), now)).toBe(true);
    expect(isNow(ev("a", "2026-12-02T15:00:00Z", "2026-12-02T16:00:00Z"), now)).toBe(false);
  });
  it("lists the next three filtered events, soonest first, not those over", () => {
    const events = [
      ev("past", "2026-12-01T17:00:00Z", "2026-12-01T18:00:00Z"),
      ev("d", "2026-12-20T17:00:00Z", "2026-12-20T18:00:00Z"),
      ev("lunch", "2026-12-03T11:00:00Z", "2026-12-03T12:00:00Z", "Lunch"),
      ev("b", "2026-12-09T17:00:00Z", "2026-12-09T18:00:00Z"),
      ev("a", "2026-12-02T17:15:00Z", "2026-12-02T18:00:00Z"),
      ev("c", "2026-12-16T17:00:00Z", "2026-12-16T18:00:00Z"),
    ];
    expect(upcomingEvents(events, now, "möte").map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
  it("picks the filtered event closest to now for a start", () => {
    const events = [
      ev("lunch", "2026-12-02T17:00:00Z", "2026-12-02T18:00:00Z", "Lunch"),
      ev("early", "2026-12-02T16:00:00Z", "2026-12-02T18:00:00Z"),
      ev("soon", "2026-12-02T17:10:00Z", "2026-12-02T18:00:00Z"),
    ];
    expect(eventForNow(events, now, "möte")?.id).toBe("soon");
    expect(eventForNow(events, new Date("2026-12-02T20:00:00Z"), "möte")).toBeNull();
  });
  it("gives Förbered möte the Swedish date and time", () => {
    expect(stockholmDateTime("2026-12-02T17:00:00.000Z")).toEqual({ date: "2026-12-02", time: "18:00" });
    expect(stockholmDateTime("2026-07-01T16:30:00.000Z")).toEqual({ date: "2026-07-01", time: "18:30" });
  });
});

describe("matchAttendees", () => {
  const people = [
    { id: "p-anna", name: "Anna Berg", email: null, member_user_id: "u-anna" },
    { id: "p-erik", name: "Erik Lund", email: "erik@example.com" },
    { id: "p-sara1", name: "Sara Ek" },
    { id: "p-sara2", name: "Sara Ek" },
    { id: "p-olle", name: "Olle Ås" },
  ];
  const members = new Map([["u-anna", "anna@example.com"]]);
  it("matches by member or own e-mail, else exact unique full name; never a first name", () => {
    const res = matchAttendees(
      [
        { email: "anna@example.com", name: null, response: "accepted" },
        { email: "erik@example.com", name: "E", response: "needsAction" },
        { email: null, name: "Sara Ek", response: "accepted" },
        { email: null, name: "Olle", response: "accepted" },
        { email: "guest@other.org", name: "Gäst", response: "accepted" },
      ],
      people,
      members,
    );
    expect(res).toEqual({ expected: ["p-anna", "p-erik"], declined: [] });
  });
  it("keeps who declined apart", () => {
    const res = matchAttendees(
      [
        { email: "anna@example.com", name: null, response: "declined" },
        { email: null, name: "olle  ås", response: "tentative" },
      ],
      people,
      members,
    );
    expect(res).toEqual({ expected: ["p-olle"], declined: ["p-anna"] });
  });
});

describe("parseMeetingEvent", () => {
  it("reads the stored form defensively", () => {
    expect(parseMeetingEvent({ title: "Möte\n1", expected: ["a", 3], declined: "x" })).toEqual({ title: "Möte 1", expected: ["a"], declined: [] });
    expect(parseMeetingEvent(null)).toBeNull();
  });
});
