import { describe, expect, it } from "vitest";
import { en, sv } from "@/lib/i18n/messages";
import { ALL_ON, allows, cleanOff, EMAIL_CATEGORIES, isEmailCategory, withCategory } from "./categories";

describe("e-mail categories", () => {
  it("every category has a Swedish label and a one-line description", () => {
    for (const c of EMAIL_CATEGORIES) {
      for (const m of [sv, en]) {
        expect(m.mailPrefs.categories[c].label.length).toBeGreaterThan(3);
        expect(m.mailPrefs.categories[c].description).not.toContain("\n");
      }
    }
  });

  it("matches the database's one list (the last migration that defines email_categories())", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../../supabase/migrations/", import.meta.url);
    const re = /function public\.email_categories\(\)[\s\S]*?array\[([^\]]*)\]::text\[\]/;
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const defining = files.filter((f) => re.test(readFileSync(new URL(f, dir), "utf8")));
    expect(defining[0]).toBe("0039_email_preferences.sql");
    const sql = readFileSync(new URL(defining.at(-1)!, dir), "utf8");
    const m = re.exec(sql);
    expect(m).not.toBeNull();
    expect(m![1].replace(/['\s]/g, "").split(",")).toEqual([...EMAIL_CATEGORIES]);
    // No other hard-coded list: constraints and writers all call email_categories().
    expect([...sql.matchAll(/array\['meeting_summary'/g)].length).toBe(1);
  });

  it("all on by default; Inga mejl alls wins; one category off keeps the rest", () => {
    expect(allows(ALL_ON, "invite")).toBe(true);
    expect(allows({ allOff: true, off: [] }, "invite")).toBe(false);
    const p = withCategory(ALL_ON, "meeting_summary", false);
    expect(p).toEqual({ allOff: false, off: ["meeting_summary"] });
    expect(allows(p, "invite")).toBe(true);
    expect(withCategory(p, "meeting_summary", true)).toEqual(ALL_ON);
  });

  it("cleans unknown and duplicate values", () => {
    expect(cleanOff(["invite", "spam", "invite", "meeting_summary"])).toEqual(["meeting_summary", "invite"]);
    expect(isEmailCategory("spam")).toBe(false);
  });
});
