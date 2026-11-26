import { describe, expect, it } from "vitest";
import { cleanContextName, findByName, resolveContext, sortContexts, suggestedContext, type ContextRow } from "./contexts";

const ctx = (id: string, name: string, created: string, used: string | null = null): ContextRow => ({
  id,
  name,
  created_at: `2026-11-${created}T10:00:00Z`,
  last_used_at: used ? `2026-11-${used}T10:00:00Z` : null,
});

describe("Privat contexts", () => {
  const all = [ctx("a", "TDDE15", "01", "20"), ctx("b", "Övrigt", "02", "25"), ctx("c", "Kundmöten", "10"), ctx("d", "Exjobb", "12")];

  it("suggests the context used last; never-used ones come after, newest first", () => {
    expect(suggestedContext(all)?.id).toBe("b");
    expect(sortContexts(all).map((c) => c.id)).toEqual(["b", "a", "d", "c"]);
    expect(suggestedContext([ctx("c", "Kundmöten", "10"), ctx("d", "Exjobb", "12")])?.id).toBe("d");
    expect(suggestedContext([])).toBeNull();
  });

  it("resolves only a context of this space", () => {
    expect(resolveContext(all, "a")?.name).toBe("TDDE15");
    expect(resolveContext(all, "x")).toBeNull();
    expect(resolveContext(all, null)).toBeNull();
    expect(resolveContext(all, 42)).toBeNull();
  });

  it("cleans a typed name to one short line", () => {
    expect(cleanContextName("  TDDE15 \n  föreläsningar ")).toBe("TDDE15 föreläsningar");
    expect(cleanContextName("   ")).toBeNull();
    expect(cleanContextName(undefined)).toBeNull();
    expect(cleanContextName("x".repeat(120))).toHaveLength(80);
  });

  it("reuses a context with the same name, whatever the case", () => {
    expect(findByName(all, "tdde15")?.id).toBe("a");
    expect(findByName(all, "ÖVRIGT")?.id).toBe("b");
    expect(findByName(all, "Nytt")).toBeNull();
  });
});
