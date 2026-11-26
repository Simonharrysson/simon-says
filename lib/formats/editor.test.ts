import { describe, expect, it } from "vitest";
import { editorToProfile, keyFromLabel, profileToEditor, type EditorState } from "./editor";
import { parseProfile } from "./schema";
import { ENKEL, STYRELSEPROTOKOLL, VECKOMOTE } from "./standard";

const ok = (s: EditorState) => {
  const r = editorToProfile(s);
  if (!r.ok) throw new Error(r.errors.join(" "));
  return r.profile;
};
const errors = (s: EditorState) => {
  const r = editorToProfile(s);
  return r.ok ? [] : r.errors;
};

describe("format editor", () => {
  it.each([VECKOMOTE, STYRELSEPROTOKOLL, ENKEL])("round trip of $kind equals the profile except kind", (p) => {
    expect(ok(profileToEditor(p))).toEqual({ ...p, kind: "learned" });
  });

  it("Må-runda hiding: off for every standard format, stored only when ticked and a Må-runda item exists", () => {
    const s = profileToEditor(VECKOMOTE);
    expect(s.hideCheckin).toBe(false);
    expect(ok(s)).not.toHaveProperty("hideCheckin");
    const on = ok({ ...s, hideCheckin: true });
    expect(on.hideCheckin).toBe(true);
    expect(profileToEditor(on).hideCheckin).toBe(true);
    expect(parseProfile(JSON.parse(JSON.stringify(on)))?.hideCheckin).toBe(true);
    // Without a Må-runda item there is nothing to hide.
    expect(ok({ ...s, hideCheckin: true, items: s.items.filter((i) => i.role !== "checkin") })).not.toHaveProperty("hideCheckin");
  });

  it("two Må-runda items → error", () => {
    const s = profileToEditor(VECKOMOTE);
    s.items.push({ label: "Hur mår vi?", role: "checkin", last: false });
    expect(errors(s)).toContain("Bara en punkt kan vara Må-runda.");
  });

  it("two follow-up items → error", () => {
    const s = profileToEditor(VECKOMOTE);
    s.items.push({ label: "Uppföljning", role: "followup", last: false });
    expect(errors(s)).toContain("Bara en punkt kan vara Från förra veckan.");
  });

  it("empty title → error", () => {
    expect(errors({ ...profileToEditor(VECKOMOTE), title: "   " })).toContain("Titeln får inte vara tom.");
  });

  it("empty item label → error", () => {
    const s = profileToEditor(VECKOMOTE);
    s.items[0].label = "";
    expect(errors(s)).toContain("Varje punkt behöver en text.");
  });

  it("no Må-runda is valid: removing the checkin item gives a profile without one", () => {
    const s = profileToEditor(VECKOMOTE);
    s.items = s.items.filter((i) => i.role !== "checkin");
    const p = ok(s);
    expect(p.fixedAgendaItems.some((i) => i.role === "checkin")).toBe(false);
    expect(p.fixedAgendaItems.map((i) => i.label)).toEqual(["Godkänn dagordning", "Från förra veckan", "Övrigt"]);
    expect(parseProfile(p)).toEqual(p);
  });

  it("a profile without fixed items at all is valid", () => {
    expect(ok({ ...profileToEditor(VECKOMOTE), items: [] }).fixedAgendaItems).toEqual([]);
  });

  it("new items get keys from their labels, unique", () => {
    const s = profileToEditor(ENKEL);
    s.items = [
      { label: "Mötets öppnande", role: "procedural", last: false },
      { label: "Mötets öppnande!", role: "procedural", last: false },
      { label: "Övriga frågor", role: "other", last: true },
    ];
    expect(ok(s).fixedAgendaItems).toEqual([
      { key: "motets-oppnande", label: "Mötets öppnande", role: "procedural" },
      { key: "motets-oppnande-2", label: "Mötets öppnande!", role: "procedural" },
      { key: "ovriga-fragor", label: "Övriga frågor", role: "other", position: "last" },
    ]);
  });

  it("sections off, empty rows dropped, style always standard", () => {
    const s = profileToEditor(VECKOMOTE);
    s.tasks.on = false;
    s.notes.on = false;
    s.infoTable = ["Datum", " ", ""];
    s.signatures = [""];
    s.requiredItems = ["  Val av justerare ", ""];
    const p = ok(s);
    expect(p.tasksSection).toBeNull();
    expect(p.notesSection).toBeNull();
    expect(p.infoTable).toEqual(["Datum"]);
    expect(p.signatures).toBeNull();
    expect(p.requiredItems).toEqual(["Val av justerare"]);
    expect(p).toMatchObject({ decisionPrefix: "Beslut:", tone: "full-sentences", taskStyle: "role-first" });
  });

  it("too long labels and too many required items → errors", () => {
    const s = profileToEditor(VECKOMOTE);
    s.items[0].label = "x".repeat(81);
    s.requiredItems = Array.from({ length: 16 }, (_, i) => `Punkt ${i}`);
    expect(errors(s)).toEqual(expect.arrayContaining(["Varje punkt får vara högst 80 tecken.", "Högst 15 punkter från stadgarna."]));
  });

  it("keyFromLabel", () => {
    expect(keyFromLabel("Godkänn dagordning")).toBe("godkann-dagordning");
    expect(keyFromLabel("!!!")).toBe("punkt");
  });
});
