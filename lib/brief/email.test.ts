import { describe, expect, it } from "vitest";
import type { BriefContent } from "./content";
import { briefSubject, briefTime, renderBriefEmail, type BriefEmailInput } from "./email";
import { BRIEF_PICK_SYSTEM_PROMPT, buildPickUserText, claudePicker } from "./pick";

const ref = (id: string, at: string, title: string | null = null) => ({ id, at, title, href: `https://app.test/orgs/o/mote/${id}` });
const content: BriefContent = {
  last: ref("m1", "2026-11-20T17:00:00Z", "Budget <och> fika"),
  decisions: [],
  promised: [{ text: "Boka Kårallen", owner: "Anna", mine: true, due: "fredag", dueDate: "2026-11-28", overdue: false, meeting: ref("m1", "2026-11-20T17:00:00Z") }],
  open: [{ text: "Skriv budget", owner: null, mine: false, due: null, dueDate: null, overdue: false, meeting: ref("m0", "2026-11-13T17:00:00Z") }],
  moreOpen: 2,
  agenda: { labels: ["Mötets öppnande", "Budget"], href: "https://docs.google.com/document/d/x/edit" },
};
const input: BriefEmailInput = {
  locale: "sv",
  recipientName: "Anna Berg",
  eventTitle: "Styrelsemöte",
  startsAt: "2026-11-27T13:00:00Z",
  groupName: "Föreningen",
  spaceName: "Föreningen",
  content,
  decisions: [{ key: "d1", text: "Hackathonet blir 14 feb", meeting: ref("m1", "2026-11-20T17:00:00Z") }],
  unsubscribeHref: "https://app.test/mejl?t=abc&k=meeting_brief",
};

describe("the Inför möten e-mail", () => {
  it("0068: the moment next to a decision, in text and HTML", () => {
    const mail = renderBriefEmail({ ...input, decisions: [{ ...input.decisions[0], saidAt: "41:52" }] });
    expect(mail.text).toContain("- Hackathonet blir 14 feb ▶ 41:52 (från mötet 20 november");
    expect(mail.html).toContain("&#9654;&nbsp;41:52");
    expect(renderBriefEmail(input).text).not.toContain("▶");
  });

  it("Swedish: subject 'Inför <titel> kl 14.00', every section with its meeting, unsubscribe", () => {
    const mail = renderBriefEmail(input);
    expect(mail.subject).toBe("Inför Styrelsemöte kl 14.00");
    expect(mail.text).toContain("Hej Anna! Föreningen ses kl 14.00.");
    expect(mail.text).toContain("SENAST NI SÅGS\n20 november: Budget <och> fika\nhttps://app.test/orgs/o/mote/m1");
    expect(mail.text).toContain("BESLUT ATT HA I HUVUDET\n- Hackathonet blir 14 feb (från mötet 20 november: https://app.test/orgs/o/mote/m1)");
    expect(mail.text).toContain("UTLOVAT\n- Du: Boka Kårallen (senast lör 28 nov)");
    expect(mail.text).toContain("ÖPPNA UPPGIFTER\n- Ingen ansvarig: Skriv budget\n- … och 2 till");
    expect(mail.text).toContain("FÖRBEREDD DAGORDNING\n- Mötets öppnande\n- Budget");
    expect(mail.text).toContain("Inga mejl inför möten: https://app.test/mejl?t=abc&k=meeting_brief");
    // Escaped in HTML.
    expect(mail.html).toContain("Budget &lt;och&gt; fika");
    expect(mail.html).not.toContain("<och>");
    expect(mail.html).toContain('lang="sv"');
    expect(mail.html).toContain("https://app.test/mejl?t=abc&amp;k=meeting_brief");
  });

  it("English, 24-hour time, and no button when there is no earlier meeting", () => {
    const mail = renderBriefEmail({ ...input, locale: "en", content: { ...content, last: null } });
    expect(mail.subject).toBe("Before Styrelsemöte at 14:00");
    expect(mail.text).toContain("Hi Anna! Föreningen meets at 14:00.");
    expect(mail.text).toContain("PROMISED\n- You: Boka Kårallen (due Sat 28 Nov)");
    expect(mail.text).not.toContain("Open the last meeting");
    expect(mail.html).toContain('lang="en"');
  });

  it("no title: the group's name; overdue said in words", () => {
    expect(briefSubject({ eventTitle: "", groupName: "Acme", startsAt: "2026-11-27T08:05:00Z" })).toBe("Inför Acme kl 09.05");
    const overdue = { ...content, promised: [{ ...content.promised[0], mine: false, dueDate: "2026-11-25", overdue: true }] };
    expect(renderBriefEmail({ ...input, content: overdue }).text).toContain("- Anna: Boka Kårallen (senast ons 25 nov, försenad)");
    expect(briefTime("2026-06-01T12:30:00Z", "sv")).toBe("14.30");
  });
});

describe("the decision picker", () => {
  it("sends only ids, dates and the stored text, as data", () => {
    const text = buildPickUserText("Budget\n2027", [{ key: "d1", text: "Vi byter\nbank", meeting: ref("m1", "2026-11-20T17:00:00Z") }]);
    expect(text).toBe("<meeting_title>Budget 2027</meeting_title>\n\n<decisions>\n[d1] (2026-11-20) Vi byter bank\n</decisions>");
    expect(BRIEF_PICK_SYSTEM_PROMPT).toContain("never invent");
  });

  it("is not called for three decisions or fewer", async () => {
    const decisions = ["d1", "d2", "d3"].map((key) => ({ key, text: key, meeting: ref("m", "2026-11-20T17:00:00Z") }));
    expect(await claudePicker()({ title: "x", decisions, orgId: "o" })).toBeNull();
  });
});
