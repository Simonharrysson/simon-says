import { describe, expect, it } from "vitest";
import { MAX_INVITES, addressPaused, inviteRecipients, maskEmail, namedPeople, reminderHour, type InvitePerson } from "./recipients";

// The growth loop's recipients (0063). Fictional data.

const people: InvitePerson[] = [
  { id: "p-anna", name: "Anna Berg", email: "anna@exempel.se" },
  { id: "p-erik", name: "Erik Lund", email: null },
  { id: "p-sara", name: "Sara Holm", email: "Sara.Holm@Exempel.se ", member_user_id: null },
  { id: "p-karin", name: "Karin Sjö", email: "karin@exempel.se", member_user_id: "u-karin" },
  { id: "p-johanna", name: "Johanna Lind", email: "johanna@exempel.se", member_user_id: "u-starter" },
  { id: "p-olle", name: "Olle Ek", email: "olle@exempel.se" },
];

const base = {
  people,
  expected: [] as string[],
  guests: [],
  named: new Set<string>(),
  accountEmails: new Set<string>(),
  starterEmail: "johanna@exempel.se",
  startedBy: "u-starter",
};

describe("inviteRecipients", () => {
  it("calendar guests (people by id, others by address) and the name round's people", () => {
    const r = inviteRecipients({
      ...base,
      expected: ["p-anna"],
      named: new Set(["p-sara", "p-anna"]),
      guests: [{ email: "Oskar@Gast.se", name: "Oskar Ek", response: "accepted" }],
    });
    expect(r.invites).toEqual([
      { email: "anna@exempel.se", name: "Anna Berg", personId: "p-anna", source: "both" },
      { email: "sara.holm@exempel.se", name: "Sara Holm", personId: "p-sara", source: "name_round" },
      { email: "oskar@gast.se", name: "Oskar Ek", personId: null, source: "calendar" },
    ]);
  });

  it("dedupes by address: a guest who is in the list is that person, two rows one mail", () => {
    const r = inviteRecipients({
      ...base,
      people: [...people, { id: "p-anna2", name: "Anna Öst", email: "ANNA@exempel.se" }],
      expected: ["p-anna", "p-anna2"],
      guests: [
        { email: "anna@exempel.se", name: "Anna", response: null },
        { email: "gast@gast.se", name: null, response: "needsAction" },
        { email: "gast@gast.se", name: "Dubbel", response: "accepted" },
      ],
    });
    expect(r.invites.map((x) => x.email)).toEqual(["anna@exempel.se", "gast@gast.se"]);
    expect(r.invites[0].personId).toBe("p-anna");
  });

  it("people without an address get nothing (counted)", () => {
    const r = inviteRecipients({ ...base, expected: ["p-erik"], guests: [{ email: null, name: "Ingen", response: null }] });
    expect(r.invites).toEqual([]);
    expect(r.withoutEmail).toBe(2);
  });

  it("an account never gets the invite: a linked row, or an address with an account", () => {
    const r = inviteRecipients({
      ...base,
      expected: ["p-karin", "p-olle"],
      guests: [{ email: "konto@gast.se", name: "Konto", response: null }],
      accountEmails: new Set(["olle@exempel.se", "konto@gast.se"]),
    });
    expect(r.invites).toEqual([]);
    expect(r.withAccount).toBe(3);
  });

  it("someone whose account uses another address: linked row → summary flow; unlinked row → invite at the listed address", () => {
    // Karin's row is linked to her account (whose sign-in address may be any): no invite.
    const linked = inviteRecipients({ ...base, expected: ["p-karin"], accountEmails: new Set(["karin.privat@gmail.test"]) });
    expect(linked.invites).toEqual([]);
    // Olle signs in as olle.privat@… but his row isn't linked: the invite goes to the listed address
    // (the claim then requires that address, and explains otherwise).
    const unlinked = inviteRecipients({ ...base, expected: ["p-olle"], accountEmails: new Set(["olle.privat@gmail.test"]) });
    expect(unlinked.invites.map((x) => x.email)).toEqual(["olle@exempel.se"]);
  });

  it("never the starter, by row or address; declined guests are skipped", () => {
    const r = inviteRecipients({
      ...base,
      expected: ["p-johanna"],
      guests: [
        { email: "johanna@exempel.se", name: "Johanna", response: "accepted" },
        { email: "nej@gast.se", name: "Nej", response: "declined" },
      ],
    });
    expect(r.invites).toEqual([]);
    expect(r.withAccount).toBe(0);
  });

  it("the tree rule leaves out people who won't see the meeting; guests are not filtered", () => {
    const r = inviteRecipients({ ...base, expected: ["p-anna", "p-olle"], allowed: new Set(["p-olle"]), guests: [{ email: "g@gast.se", name: null, response: null }] });
    expect(r.invites.map((x) => x.email)).toEqual(["olle@exempel.se", "g@gast.se"]);
    expect(r.notAllowed).toBe(1);
  });

  it("caps the meeting at MAX_INVITES", () => {
    const guests = Array.from({ length: MAX_INVITES + 3 }, (_, i) => ({ email: `g${String(i).padStart(2, "0")}@gast.se`, name: null, response: null }));
    const r = inviteRecipients({ ...base, guests });
    expect(r.invites).toHaveLength(MAX_INVITES);
    expect(r.capped).toBe(3);
  });
});

describe("namedPeople", () => {
  it("follows merges and never takes an unsure guess", () => {
    const named = namedPeople([
      { el_session_id: "s", speaker_label: "speaker_0", person_id: "p-anna", display_name: "Anna Berg" },
      { el_session_id: "s", speaker_label: "speaker_1", person_id: null, display_name: "Talare 2", merged_into_label: "speaker_2" },
      { el_session_id: "s", speaker_label: "speaker_2", person_id: "p-sara", display_name: "Sara Holm" },
      { el_session_id: "s", speaker_label: "speaker_3", person_id: "p-olle", display_name: "Olle?", needs_confirm: true },
    ]);
    expect([...named].sort()).toEqual(["p-anna", "p-sara"]);
  });
});

describe("caps and the reminder hour", () => {
  const now = new Date("2026-11-28T12:00:00Z");
  const sent = (daysAgo: number, clicked = false) => ({
    sent_at: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
    clicked_at: null,
    clicked_human_at: clicked ? new Date().toISOString() : null,
    claimed_at: null,
  });

  it("one invite per address per förening per 7 days; a 90-day pause after 3 unclicked", () => {
    expect(addressPaused([], now)).toBeNull();
    expect(addressPaused([sent(3)], now)).toBe("recent");
    expect(addressPaused([sent(8)], now)).toBeNull();
    expect(addressPaused([sent(10), sent(20), sent(30)], now)).toBe("unclicked");
    expect(addressPaused([sent(10), sent(20, true), sent(30)], now)).toBeNull();
    expect(addressPaused([sent(100), sent(120), sent(130)], now)).toBeNull();
  });

  it("reminders only between 08 and 20 Stockholm time", () => {
    expect(reminderHour(new Date("2026-11-28T06:59:00Z"))).toBe(false); // 07:59
    expect(reminderHour(new Date("2026-11-28T07:00:00Z"))).toBe(true); // 08:00
    expect(reminderHour(new Date("2026-11-28T18:59:00Z"))).toBe(true); // 19:59
    expect(reminderHour(new Date("2026-11-28T19:00:00Z"))).toBe(false); // 20:00
  });

  it("masks the invited address", () => {
    expect(maskEmail("oskar@exempel.se")).toBe("o•••@exempel.se");
  });
});
