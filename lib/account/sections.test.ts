import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { hashSection, isOpen, parseStored, preOpenScript, remember, storageKey, type SectionId } from "./sections";
import { mailSummary } from "./summary";

const none = { hash: null, forced: [] as SectionId[], stored: {} };

describe("account sections: which are open", () => {
  it("all closed by default", () => {
    for (const id of ["sprak", "mejl", "kalender", "ai", "foreningar", "integritet"] as const) expect(isOpen(id, none)).toBe(false);
  });
  it("a remembered section opens; a remembered close stays closed", () => {
    expect(isOpen("mejl", { ...none, stored: { mejl: true } })).toBe(true);
    expect(isOpen("mejl", { ...none, stored: { mejl: false } })).toBe(false);
  });
  it("a deep link and a server result open a section, even one remembered closed", () => {
    expect(isOpen("ai", { ...none, hash: "ai", stored: { ai: false } })).toBe(true);
    expect(isOpen("kalender", { ...none, forced: ["kalender"], stored: { kalender: false } })).toBe(true);
    expect(isOpen("mejl", { ...none, hash: "ai" })).toBe(false);
  });
  it("a toggle in this visit wins over everything", () => {
    expect(isOpen("ai", { override: false, hash: "ai", forced: ["ai"], stored: { ai: true } })).toBe(false);
    expect(isOpen("ai", { ...none, override: true })).toBe(true);
  });
  it("reads only known sections and booleans from storage; garbage is nothing", () => {
    expect(parseStored('{"mejl":true,"ai":false,"x":true,"sprak":"yes","konto":true}')).toEqual({ mejl: true, ai: false });
    for (const raw of [null, "", "not json", "[]", "null", "42"]) expect(parseStored(raw)).toEqual({});
  });
  it("hash: #ai and #kalender, nothing else", () => {
    expect(hashSection("#ai")).toBe("ai");
    expect(hashSection("kalender")).toBe("kalender");
    expect(hashSection("#innehall")).toBeNull();
    expect(hashSection("#%E0%A4%A")).toBeNull();
    expect(hashSection("")).toBeNull();
  });
});

describe("remember", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it("merges one section into what was stored, per account", () => {
    const s = memory();
    remember(s, storageKey("u1"), "mejl", true);
    remember(s, storageKey("u1"), "ai", true);
    remember(s, storageKey("u1"), "mejl", false);
    expect(parseStored(s.getItem(storageKey("u1")))).toEqual({ mejl: false, ai: true });
    expect(s.getItem(storageKey("u2"))).toBeNull();
  });
  it("never throws when storage is blocked or full", () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => remember(blocked, "k", "ai", true)).not.toThrow();
    expect(() => remember(null, "k", "ai", true)).not.toThrow();
  });
});

describe("pre-paint script", () => {
  /** Runs the script against a tiny fake DOM with the page's sections. */
  function run(stored: string | null, hash: string, forced: SectionId[], throwing = false) {
    const els = new Map<string, { attrs: Record<string, string>; trigger: { attrs: Record<string, string> } }>();
    for (const id of ["sprak", "mejl", "kalender", "ai"]) els.set(id, { attrs: { "data-account-section": "" }, trigger: { attrs: {} } });
    const document = {
      getElementById: (id: string) => {
        const e = els.get(id);
        if (!e) return null;
        return {
          hasAttribute: (n: string) => n in e.attrs,
          setAttribute: (n: string, v: string) => void (e.attrs[n] = v),
          querySelector: () => ({ setAttribute: (n: string, v: string) => void (e.trigger.attrs[n] = v) }),
        };
      },
    };
    const localStorage = {
      getItem: () => {
        if (throwing) throw new Error("blocked");
        return stored;
      },
    };
    runInNewContext(preOpenScript(storageKey("u1"), forced), { document, localStorage, location: { hash } });
    return (id: string) => els.get(id)!.attrs["data-state"] === "open" && els.get(id)!.trigger.attrs["aria-expanded"] === "true";
  }
  it("opens the same sections as isOpen (stored, hash, forced) and nothing else", () => {
    const open = run('{"mejl":true,"sprak":false}', "#ai", ["kalender"]);
    expect(["sprak", "mejl", "kalender", "ai"].filter(open)).toEqual(["mejl", "kalender", "ai"]);
  });
  it("blocked storage: only the hash and forced ones", () => {
    const open = run(null, "", ["kalender"], true);
    expect(["sprak", "mejl", "kalender", "ai"].filter(open)).toEqual(["kalender"]);
  });
  it("can't break out of the script tag", () => {
    expect(preOpenScript("</script><script>alert(1)//", [])).not.toContain("<");
  });
});

describe("Mejl summary", () => {
  it("counts the switches that are on", () => {
    expect(mailSummary({ allOff: false, off: [] })).toEqual({ on: 5, total: 5 });
    expect(mailSummary({ allOff: false, off: ["invite"] }, true)).toEqual({ on: 5, total: 6 });
    expect(mailSummary({ allOff: false, off: ["meeting_brief"] }, true)).toEqual({ on: 4, total: 6 });
    expect(mailSummary({ allOff: false, off: [] }, false)).toEqual({ on: 5, total: 6 });
  });
  it("Stäng av alla mejl: none on", () => {
    expect(mailSummary({ allOff: true, off: [] }, true)).toEqual({ on: 0, total: 6 });
  });
});
