import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import { en, sv } from "./messages";

// Swedish is the source of truth: English must have exactly its keys, the same placeholders
// ({name}, plurals) and the same rich-text tags (<link>…</link>), and every message must parse.

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of leaves(value, path)) out.set(k, v);
  }
  return out;
}

/** Argument names ({name}, {count, plural, …}) and tag names (<link>) of an ICU message. */
function shape(message: string): string[] {
  const args = [...message.matchAll(/\{\s*([A-Za-z_][\w]*)\s*[,}]/g)].map((m) => `{${m[1]}}`);
  const tags = [...message.matchAll(/<([A-Za-z][\w]*)>/g)].map((m) => `<${m[1]}>`);
  return [...new Set([...args, ...tags])].sort();
}

const svLeaves = leaves(sv as unknown as Tree);
const enLeaves = leaves(en as unknown as Tree);

describe("message catalogs", () => {
  it("English has exactly the Swedish keys", () => {
    expect([...enLeaves.keys()].filter((k) => !svLeaves.has(k))).toEqual([]);
    expect([...svLeaves.keys()].filter((k) => !enLeaves.has(k))).toEqual([]);
  });

  it("English uses the same placeholders and tags as Swedish", () => {
    const mismatched = [...svLeaves].filter(([key, value]) => shape(value).join() !== shape(enLeaves.get(key) ?? "").join());
    expect(mismatched.map(([key]) => key)).toEqual([]);
  });

  it("no message is empty", () => {
    for (const map of [svLeaves, enLeaves]) expect([...map].filter(([, v]) => v.trim() === "").map(([k]) => k)).toEqual([]);
  });

  it("every message parses as ICU", () => {
    for (const [locale, messages, map] of [["sv", sv, svLeaves], ["en", en, enLeaves]] as const) {
      const errors: string[] = [];
      const t = createTranslator({
        locale,
        messages,
        timeZone: "Europe/Stockholm",
        onError: (error) => {
          // Missing values are expected here (we pass none); syntax errors are not.
          if (error.code !== "FORMATTING_ERROR") errors.push(error.message);
        },
        getMessageFallback: ({ key }) => key,
      });
      for (const key of map.keys()) {
        try {
          (t.markup as (k: string, v: Record<string, unknown>) => string)(key, {});
        } catch (error) {
          errors.push(`${key}: ${(error as Error).message}`);
        }
      }
      expect(errors).toEqual([]);
    }
  });
});
