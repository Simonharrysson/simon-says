import { describe, expect, it } from "vitest";
import { ownerLabel, resolveOwner, validRole } from "./roles";

describe("validRole", () => {
  it("cleans and accepts", () => {
    expect(validRole(" Kassör ")).toBe("Kassör");
    expect(validRole("PR & Event")).toBe("PR & Event");
    expect(validRole("Vice  ordförande")).toBe("Vice ordförande");
  });
  it("rejects bad input; empty clears", () => {
    expect(validRole("a".repeat(41))).toBeNull();
    expect(validRole("Kassör: x")).toBeNull();
    expect(validRole("a b c d e")).toBeNull();
    expect(validRole("")).toBeNull();
    expect(validRole(5)).toBeNull();
  });
});

describe("ownerLabel", () => {
  const anna = { name: "Anna Berg", role: "Kassör" };
  it("uses role only when grouping by role", () => {
    expect(ownerLabel(anna, "Anna", "role")).toBe("Kassör");
    expect(ownerLabel(anna, "Anna", "person")).toBe("Anna Berg");
    expect(ownerLabel({ name: "Anna Berg" }, "Anna", "role")).toBe("Anna Berg");
    expect(ownerLabel(null, "Anna", "role")).toBe("Anna");
  });
});

describe("resolveOwner", () => {
  const people = [
    { id: "p1", name: "Anna Berg", role: "Kassör" },
    { id: "p2", name: "Olle Ek", role: "Sekreterare" },
    { id: "p3", name: "Eva Lind", role: "Ordförande" },
  ];
  it("matches names, first names and roles", () => {
    expect(resolveOwner("anna berg", people)?.id).toBe("p1");
    expect(resolveOwner("Olle", people)?.id).toBe("p2");
    expect(resolveOwner("kassören", people)?.id).toBe("p1");
    expect(resolveOwner("sekreteraren", people)?.id).toBe("p2");
    expect(resolveOwner("ordföranden", people)?.id).toBe("p3");
    expect(resolveOwner("Kassör", people)?.id).toBe("p1");
  });
  it("matches the definite form of an -ansvarig role, and still ordförande / sekreterare", () => {
    const ansvariga = [
      { id: "pr", name: "Sam Carter", role: "PR-ansvarig" },
      { id: "ev", name: "Fatima Rahimi", role: "Eventansvarig" },
      { id: "ordf", name: "Maja Holm", role: "Ordförande" },
      { id: "sekr", name: "Elin Sjöberg", role: "Sekreterare" },
    ];
    expect(resolveOwner("PR-ansvarige", ansvariga)?.id).toBe("pr");
    expect(resolveOwner("eventansvarige", ansvariga)?.id).toBe("ev");
    expect(resolveOwner("PR-ansvarig", ansvariga)?.id).toBe("pr");
    expect(resolveOwner("ordförande", ansvariga)?.id).toBe("ordf");
    expect(resolveOwner("ordföranden", ansvariga)?.id).toBe("ordf");
    expect(resolveOwner("sekreterare", ansvariga)?.id).toBe("sekr");
    expect(resolveOwner("sekreteraren", ansvariga)?.id).toBe("sekr");
  });
  it("is null when ambiguous or unknown", () => {
    expect(resolveOwner("Anna", [...people, { id: "p4", name: "Anna Ek" }])).toBeNull();
    expect(resolveOwner("Pelle", people)).toBeNull();
    expect(resolveOwner("", people)).toBeNull();
  });
});
