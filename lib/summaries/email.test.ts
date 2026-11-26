import { describe, expect, it } from "vitest";
import { genitive, renderSummaryEmail, type SummaryEmailInput } from "./email";

const base: SummaryEmailInput = {
  orgName: "LiU AI Society",
  startedAt: "2026-11-24T17:05:00Z",
  recipientName: "Sara Holm",
  missed: true,
  content: {
    decisions: ["Hackathon 14 feb, budget 8 000 kr"],
    tasks: [
      { text: "Betala hyran", owner: "Kassör", due: null, mine: true },
      { text: "Boka lokal", owner: "Erik", due: "fre", mine: false },
    ],
    other: ["Sponsorerna hör av sig i januari"],
    more: { decisions: 0, tasks: 2, other: 0 },
  },
  buttonHref: "https://docs.google.com/document/d/abc/edit",
  accessNote: null,
  settingsHref: null,
  unsubscribeHref: "https://app.test/mejl?t=tok&k=meeting_summary",
};

describe("summary e-mail", () => {
  it("subject 'Sammanfattning: <förening> <datum>' (Stockholm date)", () => {
    expect(renderSummaryEmail(base).subject).toBe("Sammanfattning: LiU AI Society 24 november");
    expect(renderSummaryEmail({ ...base, startedAt: "2026-11-24T23:30:00Z" }).subject).toBe("Sammanfattning: LiU AI Society 25 november");
  });

  it("missed: 'Du missade mötet'; otherwise neutral", () => {
    expect(renderSummaryEmail(base).text).toMatch(/^Du missade mötet 24 november\n\nHej Sara! Du var inte med på LiU AI Societys möte tisdag 24 november\./);
    const neutral = renderSummaryEmail({ ...base, missed: false });
    expect(neutral.text).toMatch(/^Mötet 24 november\n/);
    expect(neutral.html).not.toContain("missade");
  });

  it("own tasks first under 'Dina uppgifter', the rest with owners, the remainder counted", () => {
    const { text, html } = renderSummaryEmail(base);
    expect(text).toContain("DINA UPPGIFTER\n- Betala hyran\n");
    expect(text).toContain("ÖVRIGA UPPGIFTER\n- Erik: Boka lokal (fre)\n- … och 2 till i protokollet");
    expect(text).toContain("BESLUT\n- Hackathon 14 feb, budget 8 000 kr");
    expect(text).toContain("ÖVRIGT\n- Sponsorerna hör av sig i januari");
    expect(html).toContain("Dina uppgifter");
    expect(html).toContain("Öppna protokollet");
  });

  it("escapes every text and link", () => {
    const evil = renderSummaryEmail({
      ...base,
      orgName: `<script>alert(1)</script>`,
      recipientName: `"><img src=x>`,
      content: { ...base.content, decisions: [`<b>fet</b> & "citat"`] },
      buttonHref: `https://x.test/?a="><script>`,
    });
    expect(evil.html).not.toMatch(/<script>|<img|<b>fet/);
    expect(evil.html).toContain("&lt;b&gt;fet&lt;/b&gt; &amp; &quot;citat&quot;");
  });

  it("footer: unsubscribe for everyone, the setting only for admins", () => {
    expect(renderSummaryEmail(base).html).not.toContain("Ändra vilka som får sammanfattningar");
    const admin = renderSummaryEmail({ ...base, settingsHref: "https://app.test/orgs/o#installningar" });
    expect(admin.html).toContain("Ändra vilka som får sammanfattningar");
    expect(admin.html).toContain("Avsluta prenumeration");
    expect(admin.text).toContain("Ändra vilka som får sammanfattningar: https://app.test/orgs/o#installningar");
    expect(admin.text).toContain("Avsluta prenumeration: https://app.test/mejl?t=tok&k=meeting_summary");
  });

  it("an access note goes under the button", () => {
    const r = renderSummaryEmail({ ...base, accessNote: "Be Anna dela det med dig." });
    expect(r.text).toContain("Öppna protokollet: https://docs.google.com/document/d/abc/edit\nBe Anna dela det med dig.");
    expect(r.html).toContain("Be Anna dela det med dig.");
  });

  it("no line breaks in the subject", () => {
    expect(renderSummaryEmail({ ...base, orgName: "A\r\nBcc: x@y" }).subject).not.toMatch(/[\r\n]/);
  });

  it("genitive", () => {
    expect([genitive("Exempelföreningen"), genitive("LiU AI Society"), genitive("Hook & Look Golf"), genitive("Lions")]).toEqual([
      "Exempelföreningens",
      "LiU AI Societys",
      "Hook & Look Golfs",
      "Lions",
    ]);
  });
});

describe("summary e-mail in English (the recipient chose English)", () => {
  it("translates the frame, keeps the meeting's own text as written", () => {
    const { subject, text, html } = renderSummaryEmail({ ...base, locale: "en" });
    expect(subject).toBe("Summary: LiU AI Society 24 November");
    expect(text).toMatch(/^You missed the meeting on 24 November\n\nHi Sara! You weren't at the LiU AI Society meeting on Tuesday 24 November\./);
    expect(text).toContain("YOUR TASKS");
    expect(text).toContain("Betala hyran");
    expect(html).toContain('<html lang="en"');
    expect(html).toContain("Unsubscribe");
    expect(html).not.toContain("Avsluta prenumeration");
  });
});
