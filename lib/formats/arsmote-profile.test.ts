import { describe, expect, it } from "vitest";
import { arsmoteProfile } from "./arsmote-profile";
import { ARSMOTE } from "./standard";

describe("arsmoteProfile", () => {
  it("no items → the standard Årsmöte", () => {
    expect(arsmoteProfile([])).toBe(ARSMOTE);
  });

  it("the stadgar's order; standard items keep key and role; closing items added last", () => {
    const p = arsmoteProfile(["Mötets öppnande", "Val av justerare och rösträknare", "Fastställande av medlemsavgift", "Val av revisorer"]);
    expect(p.kind).toBe("arsmote");
    expect(p.fixedAgendaItems.map((i) => [i.key, i.label, i.role, i.position ?? ""])).toEqual([
      ["open", "Mötets öppnande", "procedural", ""],
      ["adjuster", "Val av justerare och rösträknare", "procedural", ""],
      ["s1", "Fastställande av medlemsavgift", "other", ""],
      ["s2", "Val av revisorer", "other", ""],
      ["other", "Övriga frågor", "other", "last"],
      ["close", "Mötets avslutande", "procedural", "last"],
    ]);
  });

  it("caps at 18 stadgar items (+ closing), drops duplicates, stays valid", () => {
    const items = Array.from({ length: 25 }, (_, i) => `Ärende ${i + 1}`);
    const p = arsmoteProfile([...items, "ärende 1"]);
    expect(p.fixedAgendaItems.length).toBe(20);
    expect(new Set(p.fixedAgendaItems.map((i) => i.key)).size).toBe(20);
  });
});
