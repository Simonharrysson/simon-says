import { describe, expect, it } from "vitest";
import { ALL_ON, allows, cleanOff, EMAIL_CATEGORIES, EMAIL_CATEGORY_INFO, isEmailCategory, withCategory } from "./categories";

describe("e-mail categories", () => {
  it("every category has a Swedish label and a one-line description", () => {
    for (const c of EMAIL_CATEGORIES) {
      expect(EMAIL_CATEGORY_INFO[c].label.length).toBeGreaterThan(3);
      expect(EMAIL_CATEGORY_INFO[c].description).not.toContain("\n");
    }
  });

  it("matches the categories the database accepts (0039 check constraints)", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../supabase/migrations/0039_email_preferences.sql", import.meta.url), "utf8");
    const lists = [...sql.matchAll(/array\[([^\]]*)\]::text\[\]/g)].map((m) => m[1]);
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) expect(list.replace(/['\s]/g, "").split(",")).toEqual([...EMAIL_CATEGORIES]);
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
