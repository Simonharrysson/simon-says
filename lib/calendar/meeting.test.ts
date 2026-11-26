import { beforeAll, describe, expect, it } from "vitest";
import { useTestEnv } from "@/test/env";

// The calendar event in the meeting's Doc name, header line and name round (todo #14): unchanged
// without an event.

beforeAll(useTestEnv);

describe("Doc names and the header with a calendar event", () => {
  it("meetingTitle puts the event's title before the förening's name", async () => {
    const { meetingTitle } = await import("@/lib/docs/create");
    const at = new Date("2026-11-24T13:05:00Z");
    expect(meetingTitle("Hook & Look", at, { eventTitle: "Styrelsemöte" })).toBe("2026-11-24 14.05 Mötesprotokoll – Styrelsemöte – Hook & Look");
    expect(meetingTitle("Hook & Look", at, { eventTitle: "  " })).toBe("2026-11-24 14.05 Mötesprotokoll – Hook & Look");
  });

  it("preparedTitle does the same for Förbered möte", async () => {
    const { preparedTitle } = await import("@/lib/prepare/prepare");
    expect(preparedTitle("Hook & Look", "2026-12-02", "18:00", "Styrelse\nmöte")).toBe("2026-12-02 18.00 Dagordning – Styrelse möte – Hook & Look");
    expect(preparedTitle("Hook & Look", "2026-12-02", null)).toBe("2026-12-02 Dagordning – Hook & Look");
  });

  it("the header line carries the event's title only when the meeting has one", async () => {
    const { headerWithEvent, liveHeader } = await import("@/lib/meetings/tick");
    const h = liveHeader(new Date("2026-11-24T17:05:00Z"), "format");
    expect(headerWithEvent(h, null)).toBe(h);
    expect(headerWithEvent(h, { title: "Styrelsemöte", expected: [], declined: [] })).toBe(`Styrelsemöte · ${h}`);
    expect(headerWithEvent(h, { title: "" })).toBe(h);
  });
});

describe("the name round's calendar hint", () => {
  it("lists invited known people as a hint, and nothing extra without an event", async () => {
    const { buildNamesRequest } = await import("@/lib/names/extract");
    const seg = [{ el_session_id: "s1", speaker: "speaker_0", text: "Hej", start_ms: 0 }];
    const text = (r: ReturnType<typeof buildNamesRequest>) => JSON.stringify(r.messages);
    const plain = text(buildNamesRequest(seg as never, ["Anna Berg", "Erik Lund"]));
    expect(plain).not.toContain("Invited");
    const hinted = text(buildNamesRequest(seg as never, ["Anna Berg", "Erik Lund"], ["Erik Lund", "Gäst Utomstående"]));
    expect(hinted).toContain("Invited to this meeting in the calendar");
    expect(hinted).toContain("Erik Lund");
    expect(hinted).not.toContain("Gäst Utomstående");
  });
});
