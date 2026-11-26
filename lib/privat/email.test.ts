import { describe, expect, it } from "vitest";
import { LIST_MAX, privatSubject, renderPrivatEmail, type PrivatEmailInput } from "./email";

const base: PrivatEmailInput = {
  locale: "sv",
  contextName: "TDDE15",
  startedAt: "2026-11-26T09:05:00Z",
  content: {
    summary: "Vi gick igenom labb 2 och delade upp rapporten.",
    decisions: ["Labb 2 lämnas in på fredag"],
    facts: ["Tentan är 14 januari"],
    tasks: [
      { text: "Skriv inledningen", owner: null, due: "torsdag" },
      { text: "Fixa figurerna", owner: "Anna", due: null },
    ],
    questions: ["Får man ha med formelblad?"],
    sinceLast: [
      { taskId: "1", text: "Boka grupprum", owner: null, status: "done" },
      { taskId: "2", text: "Läsa kapitel 4", owner: null, status: "not_mentioned" },
      { taskId: "3", text: "Mejla läraren", owner: "Anna", status: "open" },
    ],
  },
  meetingHref: "https://simonsays.test/privat/mote/m1",
  unsubscribeHref: "https://simonsays.test/mejl?t=abc",
};

describe("the Privat summary e-mail", () => {
  it("has every section, my tasks apart from others', and Sedan sist with klart / öppen / inte nämnd", () => {
    const mail = renderPrivatEmail(base);
    expect(mail.subject).toBe("TDDE15: sammanfattning 26 nov 10.05");
    expect(mail.text).toContain("SAMMANFATTNING\nVi gick igenom labb 2");
    expect(mail.text).toContain("MINA UPPGIFTER\n- Skriv inledningen (torsdag)");
    expect(mail.text).toContain("ANDRAS UPPGIFTER\n- Anna: Fixa figurerna");
    expect(mail.text).toContain("BESLUT\n- Labb 2 lämnas in på fredag");
    expect(mail.text).toContain("ÖPPNA FRÅGOR\n- Får man ha med formelblad?");
    expect(mail.text).toContain("SEDAN SIST\n- Boka grupprum — klart\n- Mejla läraren (Anna) — öppen\n- Läsa kapitel 4 — inte nämnd");
    expect(mail.text).toContain("Öppna i Simon Says: https://simonsays.test/privat/mote/m1");
    expect(mail.text).toContain("Avsluta prenumeration: https://simonsays.test/mejl?t=abc");
    expect(mail.html).toContain('lang="sv"');
    expect(mail.html).toContain("Mina uppgifter");
    expect(mail.preview).toBe("1 beslut och 2 uppgifter");
  });

  it("in English when that is the user's language", () => {
    const mail = renderPrivatEmail({ ...base, locale: "en" });
    expect(mail.subject).toBe("TDDE15: summary 26 Nov 10:05");
    expect(mail.text).toContain("SINCE LAST TIME\n- Boka grupprum — done");
    expect(mail.text).toContain("MY TASKS");
    expect(mail.html).toContain('lang="en"');
  });

  it("escapes everything and leaves empty sections out", () => {
    const mail = renderPrivatEmail({
      ...base,
      contextName: "<b>Kurs</b>",
      content: { summary: "a < b", decisions: [], facts: [], tasks: [], questions: [], sinceLast: [] },
    });
    expect(mail.html).not.toContain("<b>Kurs</b>");
    expect(mail.html).toContain("&lt;b&gt;Kurs&lt;/b&gt;");
    expect(mail.text).not.toContain("BESLUT");
    expect(mail.text).not.toContain("SEDAN SIST");
    expect(mail.preview).toBe("Det viktigaste från inspelningen.");
  });

  it("long lists are cut with a count", () => {
    const decisions = Array.from({ length: LIST_MAX + 3 }, (_, i) => `Beslut ${i}`);
    const mail = renderPrivatEmail({ ...base, content: { ...base.content, decisions } });
    expect(mail.text).toContain("- … och 3 till i Simon Says");
    expect(mail.text).not.toContain(`Beslut ${LIST_MAX}`);
  });

  it("subjects stay on one line and short", () => {
    expect(privatSubject("sv", "a\nb", base.startedAt)).not.toContain("\n");
    expect(privatSubject("sv", "x".repeat(200), base.startedAt).length).toBeLessThanOrEqual(90);
  });
});
