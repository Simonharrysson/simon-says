import { describe, expect, it } from "vitest";
import { isSettingsCode, orgTab, orgTabHref } from "./tabs";

describe("orgTab", () => {
  it("?flik= picks the tab; Inställningar only for admins", () => {
    expect(orgTab({ isAdmin: true })).toBe("moten");
    expect(orgTab({ flik: "oversikt", isAdmin: false })).toBe("oversikt");
    expect(orgTab({ flik: "installningar", isAdmin: true })).toBe("installningar");
    expect(orgTab({ flik: "installningar", isAdmin: false })).toBe("moten");
    expect(orgTab({ flik: "nagot", isAdmin: true })).toBe("moten");
  });

  it("a settings form's message opens Inställningar for an admin", () => {
    expect(orgTab({ isAdmin: true, noticeCode: "namn" })).toBe("installningar");
    expect(orgTab({ isAdmin: true, noticeCode: "admin-ny" })).toBe("installningar");
    expect(orgTab({ isAdmin: true, noticeCode: "medlem-last_admin" })).toBe("installningar");
    expect(orgTab({ isAdmin: true, noticeCode: "mote" })).toBe("moten");
    // Stepped down: no longer an admin, so Möten.
    expect(orgTab({ isAdmin: false, noticeCode: "admin-bort" })).toBe("moten");
    // An explicit tab wins.
    expect(orgTab({ flik: "oversikt", isAdmin: true, noticeCode: "namn" })).toBe("oversikt");
  });
});

describe("isSettingsCode", () => {
  it("knows the settings codes", () => {
    for (const c of ["namn", "sammanfattning", "kalender", "medlem", "org-active", "admin-bort", "rollnamn", "personnamn"]) expect(isSettingsCode(c)).toBe(true);
    for (const c of ["mote", "avslutat", "mote-active", undefined, null, ""]) expect(isSettingsCode(c)).toBe(false);
  });
});

describe("orgTabHref", () => {
  it("keeps the URLs stable", () => {
    expect(orgTabHref("o", "moten")).toBe("/orgs/o");
    expect(orgTabHref("o", "oversikt")).toBe("/orgs/o?flik=oversikt");
    expect(orgTabHref("o", "installningar")).toBe("/orgs/o?flik=installningar");
  });
});
