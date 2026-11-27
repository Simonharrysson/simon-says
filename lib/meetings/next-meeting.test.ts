import { describe, expect, it } from "vitest";
import { heroDay, JUST_ENDED_MS, nextMeetingState, type HeroEvent, type HeroInput, type HeroMeeting, type HeroPrepared } from "./next-meeting";

// Friday 27 Nov 2026, 14.00 in Stockholm.
const now = new Date("2026-11-27T13:00:00Z");
const today = "2026-11-27";
const base: HeroInput = { meetings: [], prepared: [], now, today, canPrepare: true };
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const meeting = (over: Partial<HeroMeeting> = {}): HeroMeeting => ({ id: "m1", status: "done", started_at: ago(3 * 3600_000), ended_at: ago(2 * 3600_000), started_by: "u1", ...over });
const agenda = (date: string): HeroPrepared => ({ date, time: "18:00", kind: "veckomote", docUrl: "https://docs.google.com/document/d/x/edit" });
const event = (date: string, over: Partial<HeroEvent> = {}): HeroEvent => ({ id: `ev-${date}`, title: "Styrelsemöte", date, time: "18:00", now: false, ...over });

describe("nextMeetingState: the Möten tab's Nästa möte card", () => {
  it("nothing known: not prepared, no day", () => {
    expect(nextMeetingState(base)).toEqual({ kind: "unprepared", event: null, day: null });
  });

  it("a running meeting wins over everything: live (Fortsätt mötet)", () => {
    const s = nextMeetingState({ ...base, meetings: [meeting(), meeting({ id: "m2", status: "live", started_at: ago(600_000), ended_at: null })], prepared: [agenda(today)] });
    expect(s).toEqual({ kind: "live", meetingId: "m2" });
  });

  it("a live Testmöte is still live (it has controls)", () => {
    expect(nextMeetingState({ ...base, meetings: [meeting({ status: "live", ended_at: null, isTest: true })] }).kind).toBe("live");
  });

  it("Avsluta pressed: ending while the final pass writes the notes", () => {
    expect(nextMeetingState({ ...base, meetings: [meeting({ status: "ending", ended_at: null })] })).toEqual({ kind: "ending", meetingId: "m1" });
  });

  it("just ended: the recap for 12 hours after the end", () => {
    expect(nextMeetingState({ ...base, meetings: [meeting({ ended_at: ago(JUST_ENDED_MS) })] })).toEqual({ kind: "ended", meetingId: "m1" });
    expect(nextMeetingState({ ...base, meetings: [meeting({ ended_at: ago(JUST_ENDED_MS + 1) })] }).kind).toBe("unprepared");
  });

  it("an end time in the future (a clock or seed oddity) is never 'just ended'", () => {
    expect(nextMeetingState({ ...base, meetings: [meeting({ ended_at: new Date(now.getTime() + 60_000).toISOString() })] }).kind).toBe("unprepared");
  });

  it("the newest finished meeting is the one recapped; abandoned ones are not", () => {
    const s = nextMeetingState({
      ...base,
      meetings: [meeting({ id: "old", ended_at: ago(5 * 3600_000) }), meeting({ id: "new", ended_at: ago(3600_000) }), meeting({ id: "gone", status: "abandoned", ended_at: ago(60_000) })],
    });
    expect(s).toEqual({ kind: "ended", meetingId: "new" });
  });

  it("a just-ended Testmöte never takes the card", () => {
    expect(nextMeetingState({ ...base, meetings: [meeting({ isTest: true })] }).kind).toBe("unprepared");
  });

  it("once the next meeting is prepared (a later day), it replaces the recap", () => {
    expect(nextMeetingState({ ...base, meetings: [meeting()], prepared: [agenda("2026-12-01")] }).kind).toBe("prepared");
    // An agenda for the same day as the meeting that just ended was that meeting's: the recap stays.
    expect(nextMeetingState({ ...base, meetings: [meeting()], prepared: [agenda(today)] }).kind).toBe("ended");
  });

  it("prepared: the soonest agenda from today on, with its day", () => {
    const s = nextMeetingState({ ...base, prepared: [agenda("2026-12-08"), agenda("2026-12-01"), agenda("2026-11-20")] });
    expect(s).toEqual({ kind: "prepared", prepared: agenda("2026-12-01"), event: null, day: { type: "weekday", weekday: 2 } });
  });

  it("a calendar event on the prepared day is the same meeting: prepared, with the event's title", () => {
    const s = nextMeetingState({ ...base, prepared: [agenda("2026-12-01")], events: [event("2026-12-01"), event("2026-12-08")] });
    expect(s).toMatchObject({ kind: "prepared", event: { id: "ev-2026-12-01" } });
  });

  it("the calendar's next meeting comes before the prepared one: that one is next, not prepared", () => {
    const s = nextMeetingState({ ...base, prepared: [agenda("2026-12-08")], events: [event("2026-12-01"), event("2026-12-08")] });
    expect(s).toEqual({ kind: "unprepared", event: event("2026-12-01"), day: { type: "weekday", weekday: 2 } });
  });

  it("calendar only: the next event feeds Nästa möte, soonest first; past days are skipped", () => {
    const s = nextMeetingState({ ...base, events: [event("2026-12-03"), event("2026-11-28"), event("2026-11-26")] });
    expect(s).toEqual({ kind: "unprepared", event: event("2026-11-28"), day: { type: "tomorrow" } });
  });

  it("an event happening now is carried, so the card can offer Starta for it", () => {
    const s = nextMeetingState({ ...base, events: [event(today, { now: true })] });
    expect(s).toMatchObject({ kind: "unprepared", event: { now: true }, day: { type: "today" } });
  });

  describe("Företag", () => {
    const foretag: HeroInput = { ...base, canPrepare: false, onlyStartedBy: "me" };

    it("no Förbered and no calendar: just Starta, even with agendas or events given", () => {
      expect(nextMeetingState({ ...foretag, prepared: [agenda(today)], events: [event(today)] })).toEqual({ kind: "start" });
    });

    it("live and just ended count only the viewer's own meetings (as myLiveId)", () => {
      const colleague = meeting({ id: "theirs", status: "live", ended_at: null, started_by: "other" });
      expect(nextMeetingState({ ...foretag, meetings: [colleague] })).toEqual({ kind: "start" });
      expect(nextMeetingState({ ...foretag, meetings: [colleague, meeting({ id: "mine", status: "live", ended_at: null, started_by: "me" })] })).toEqual({ kind: "live", meetingId: "mine" });
      expect(nextMeetingState({ ...foretag, meetings: [meeting({ id: "x", started_by: "other" })] })).toEqual({ kind: "start" });
      expect(nextMeetingState({ ...foretag, meetings: [meeting({ id: "y", started_by: "me" })] })).toEqual({ kind: "ended", meetingId: "y" });
    });
  });
});

describe("heroDay", () => {
  it("today, tomorrow, a weekday within the week, else the date", () => {
    expect(heroDay("2026-11-27", today)).toEqual({ type: "today" });
    expect(heroDay("2026-11-28", today)).toEqual({ type: "tomorrow" });
    expect(heroDay("2026-12-01", today)).toEqual({ type: "weekday", weekday: 2 });
    expect(heroDay("2026-12-03", today)).toEqual({ type: "weekday", weekday: 4 });
    expect(heroDay("2026-12-04", today)).toEqual({ type: "date", date: "2026-12-04" });
  });

  it("across the change to winter time the day count stays whole", () => {
    expect(heroDay("2026-10-27", "2026-10-24")).toEqual({ type: "weekday", weekday: 2 });
  });
});
