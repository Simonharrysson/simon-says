import { describe, expect, it } from "vitest";
import { inviteFromName, renderInviteEmail, type InviteEmailInput } from "./email";

// The invite mail and its reminder (0063), as in the owner-approved mock. Fictional data.

const base: InviteEmailInput = {
  orgName: "Sjöstadens Kanotklubb",
  starterName: "Johanna Lind",
  title: "Styrelsemöte november",
  startedAt: "2026-11-24T17:05:00Z",
  recipientName: "Oskar Ek",
  mine: [
    { text: "Boka bryggan för vårstädningen", owner: "Oskar", due: "fre 4 dec", doneWhen: "bokningsbekräftelsen ligger i styrelsemappen", mine: true },
    { text: "Ta in två offerter på nya flytvästar", owner: "Oskar", due: "mån 14 dec", mine: true },
  ],
  decisions: ["Vårstädningen blir lördag 18 april.", "Juniorgruppen får 6 000 kr.", "Tredje beslutet", "Fjärde beslutet"],
  counts: { decisions: 4, tasks: 6 },
  named: false,
  reason: "guest",
  claimHref: "https://app.test/r/tok",
  upsellHref: "https://app.test/r/tok?till=eget",
  unsubscribeHref: "https://app.test/mejl?t=x&k=meeting_invite",
};

describe("the invite mail", () => {
  it("subject, personal preheader, own tasks in full, two decisions then the rest as a count", () => {
    const m = renderInviteEmail(base);
    expect(m.subject).toBe('Johanna bjöd in dig till "Styrelsemöte november"');
    expect(m.preview).toBe("Du har 2 uppgifter från mötet");
    expect(m.text).toContain("Johanna Linds anteckningar · Sjöstadens Kanotklubb");
    expect(m.text).toContain("4 beslut · 6 uppgifter");
    expect(m.text).toContain("DINA UPPGIFTER (2)");
    expect(m.text).toContain("Boka bryggan för vårstädningen (vem: du, när: fre 4 dec, klart när: bokningsbekräftelsen ligger i styrelsemappen)");
    expect(m.text).toContain("Juniorgruppen får 6 000 kr.");
    expect(m.text).not.toContain("Tredje beslutet");
    expect(m.text).toContain("…och 2 beslut till");
    expect(m.text).toContain("Läs allt och bocka av: https://app.test/r/tok");
    expect(m.text).toContain("du stod på mötets gästlista. Vi skickar högst en påminnelse.");
    expect(m.text).toContain("Avsluta prenumeration: https://app.test/mejl?t=x&amp;k=meeting_invite".replace("&amp;", "&"));
    expect(m.text).toContain("Gratis för din förening – starta ett eget möte: https://app.test/r/tok?till=eget");
    expect(m.html).toContain(">Läs allt och bocka av</a>");
    expect(m.html).toContain("starta ett eget möte</a>");
    expect(m.html).not.toContain("<img");
  });

  it("the preheader never claims a mention that didn't happen", () => {
    expect(renderInviteEmail({ ...base, mine: [], named: true }).preview).toBe("Du nämndes i mötet");
    expect(renderInviteEmail({ ...base, mine: [], named: false }).preview).toBe("4 beslut och 6 uppgifter från mötet");
    expect(renderInviteEmail({ ...base, mine: [base.mine[0]] }).preview).toBe("Du har 1 uppgift från mötet");
  });

  it("the reason is true for the recipient; no title: the date", () => {
    const m = renderInviteEmail({ ...base, reason: "attended", title: null });
    expect(m.subject).toBe('Johanna bjöd in dig till "Mötet 24 november"');
    expect(m.text).toContain("och du var med på mötet.");
  });

  it("escapes everything", () => {
    const m = renderInviteEmail({ ...base, orgName: "<b>Klubb</b>", mine: [{ text: "<script>x</script>", owner: null, due: null, mine: true }] });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<b>Klubb</b>");
    expect(m.html).toContain("&lt;script&gt;");
  });

  it("the reminder: tasks and the button only, the one reminder, no upsell", () => {
    const m = renderInviteEmail({ ...base, reminder: true });
    expect(m.subject).toBe('(Påminnelse) Johanna bjöd in dig till "Styrelsemöte november"');
    expect(m.preview).toBe("Dina 2 uppgifter från mötet väntar fortfarande");
    expect(m.text).toContain("Det här är den enda påminnelsen.");
    expect(m.text).toContain("Det här var sista mejlet om mötet.");
    expect(m.text).not.toContain("BESLUT");
    expect(m.text).not.toContain("Gratis för din förening");
    expect(m.html).not.toContain("starta ett eget möte");
  });

  it("goes in English for an English recipient; From is the starter via Simon Says", () => {
    const m = renderInviteEmail({ ...base, locale: "en" });
    expect(m.subject).toBe('Johanna invited you to "Styrelsemöte november"');
    expect(m.text).toContain("Johanna Lind's notes");
    expect(inviteFromName({ starterName: "Johanna Lind" })).toBe("Johanna via Simon Says");
  });
});
