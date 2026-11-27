import { describe, expect, it } from "vitest";
import { isSettingsCode, orgTab, orgTabHref, settingsHref, settingsSection } from "./tabs";

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

describe("settingsSection", () => {
  it("?del= picks the section; anything else is Föreningen", () => {
    expect(settingsSection({})).toBe("foreningen");
    expect(settingsSection({ del: "moten" })).toBe("moten");
    expect(settingsSection({ del: "efter-motet" })).toBe("efter-motet");
    expect(settingsSection({ del: "nagot" })).toBe("foreningen");
  });

  it("a form's message opens the section it is about; ?del= wins", () => {
    expect(settingsSection({ noticeCode: "namn" })).toBe("foreningen");
    expect(settingsSection({ noticeCode: "admin-ny" })).toBe("styrelsen");
    expect(settingsSection({ noticeCode: "medlem-last_admin" })).toBe("styrelsen");
    expect(settingsSection({ noticeCode: "personnamn" })).toBe("styrelsen");
    expect(settingsSection({ noticeCode: "grupper" })).toBe("styrelsen");
    expect(settingsSection({ noticeCode: "grupp-arkiv" })).toBe("styrelsen");
    expect(settingsSection({ noticeCode: "sammanfattning" })).toBe("efter-motet");
    expect(settingsSection({ noticeCode: "kalender-ok" })).toBe("moten");
    expect(settingsSection({ noticeCode: "org-active" })).toBe("radera");
    expect(settingsSection({ noticeCode: "mote" })).toBe("foreningen");
    expect(settingsSection({ del: "radera", noticeCode: "namn" })).toBe("radera");
  });

  it("links a section", () => {
    expect(settingsHref("x", "moten")).toBe("/orgs/x?flik=installningar&del=moten");
  });
});
