import { describe, expect, it } from "vitest";
import {
  ABOUT_MAX,
  profileErrors,
  hasProfile,
  normalizeAbout,
  normalizeFacebook,
  normalizeInstagram,
  normalizeWebsite,
  parseProfile,
  profileInput,
  sameProfile,
  websiteLabel,
} from "./profile";

// The same shapes the 0044 checks accept (supabase/migrations/0044_org_about.sql).
const DB_WEBSITE = /^https:\/\/[^\s/?#@]+\.[^\s/?#@]+\/\S*$/;
const DB_FACEBOOK = /^https:\/\/facebook\.com\/[^\s/?#][^\s]*$/;
const DB_INSTAGRAM = /^https:\/\/instagram\.com\/[A-Za-z0-9._]{1,30}$/;

describe("Om oss text", () => {
  it("keeps line breaks, turns CRLF into LF and trims", () => {
    expect(normalizeAbout("  Vi spelar golf.\r\n\r\nVarje tisdag.  ")).toBe("Vi spelar golf.\n\nVarje tisdag.");
    expect(normalizeAbout("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("empty is null, too long is invalid (counted as the database counts)", () => {
    expect(normalizeAbout("   \n ")).toBeNull();
    expect(normalizeAbout("x".repeat(ABOUT_MAX))).toHaveLength(ABOUT_MAX);
    expect(normalizeAbout("x".repeat(ABOUT_MAX + 1))).toBeUndefined();
    // 600 emoji are 1200 UTF-16 units but 600 characters in Postgres.
    expect(normalizeAbout("⛳".repeat(ABOUT_MAX))).not.toBeUndefined();
  });

  it("keeps HTML-looking text as plain text (React escapes it)", () => {
    expect(normalizeAbout("<b>Hej</b> <3")).toBe("<b>Hej</b> <3");
  });
});

describe("website", () => {
  it("adds https:// and gives the canonical href", () => {
    expect(normalizeWebsite("exempel.se")).toBe("https://exempel.se/");
    expect(normalizeWebsite("https://www.exempel.se/om-oss")).toBe("https://www.exempel.se/om-oss");
    expect(normalizeWebsite("")).toBeNull();
  });

  it("refuses anything but https to a real host", () => {
    for (const bad of ["http://exempel.se", "javascript:alert(1)", "ftp://exempel.se", "https://localhost", "exempel", "https://user:pw@exempel.se", "exempel .se"]) {
      expect(normalizeWebsite(bad), bad).toBeUndefined();
    }
  });

  it("matches the database check", () => {
    for (const ok of ["exempel.se", "https://a.b.c/x?y=1#z", "golf.exempel.se:8443/a"]) expect(normalizeWebsite(ok)).toMatch(DB_WEBSITE);
  });

  it("labels it by host", () => {
    expect(websiteLabel("https://www.exempel.se/om")).toBe("exempel.se");
  });
});

describe("Facebook", () => {
  it("takes a name or a facebook.com URL", () => {
    expect(normalizeFacebook("hooklook")).toBe("https://facebook.com/hooklook");
    expect(normalizeFacebook("@hooklook")).toBe("https://facebook.com/hooklook");
    expect(normalizeFacebook("facebook.com/hooklook/")).toBe("https://facebook.com/hooklook");
    expect(normalizeFacebook("https://www.facebook.com/hooklook?ref=bookmarks")).toBe("https://facebook.com/hooklook");
    expect(normalizeFacebook("https://m.facebook.com/groups/12345")).toBe("https://facebook.com/groups/12345");
    expect(normalizeFacebook("https://www.facebook.com/profile.php?id=1000123")).toBe("https://facebook.com/profile.php?id=1000123");
  });

  it("refuses other hosts, http and look-alikes", () => {
    for (const bad of [
      "http://facebook.com/x",
      "https://facebook.com.evil.com/x",
      "https://evil.com/facebook.com",
      "https://facebook.com@evil.com/x",
      "https://facebook.com/",
      "facebook.com",
      "https://instagram.com/x",
      "https://facebook.com/profile.php",
      "javascript:alert(1)",
      "hook look",
    ]) {
      expect(normalizeFacebook(bad), bad).toBeUndefined();
    }
  });

  it("matches the database check", () => {
    for (const ok of ["x", "https://www.facebook.com/profile.php?id=1", "facebook.com/groups/1/"]) expect(normalizeFacebook(ok)).toMatch(DB_FACEBOOK);
  });
});

describe("Instagram", () => {
  it("normalises a handle or URL to https://instagram.com/<handle>", () => {
    expect(normalizeInstagram("@hooklook")).toBe("https://instagram.com/hooklook");
    expect(normalizeInstagram("hook.look_")).toBe("https://instagram.com/hook.look_");
    expect(normalizeInstagram("instagram.com/hooklook")).toBe("https://instagram.com/hooklook");
    expect(normalizeInstagram("https://www.instagram.com/hooklook/?igsh=abc")).toBe("https://instagram.com/hooklook");
  });

  it("refuses other hosts, paths and bad handles", () => {
    for (const bad of [
      "http://instagram.com/x",
      "https://instagram.com.evil.com/x",
      "https://evil.com/instagram.com",
      "https://instagram.com@evil.com/x",
      "https://instagram.com/p/abc",
      "https://instagram.com/",
      "@hook-look",
      "@" + "a".repeat(31),
    ]) {
      expect(normalizeInstagram(bad), bad).toBeUndefined();
    }
  });

  it("matches the database check", () => {
    expect(normalizeInstagram("@hooklook")).toMatch(DB_INSTAGRAM);
  });
});

describe("the whole profile", () => {
  it("parses every field, empty = null", () => {
    expect(parseProfile({ about: "Hej", website: "", facebook: "", instagram: "@hooklook" })).toEqual({
      ok: true,
      profile: { about: "Hej", website_url: null, facebook_url: null, instagram_url: "https://instagram.com/hooklook" },
    });
  });

  it("gives a sentence for each wrong field", () => {
    const r = parseProfile({ about: "x".repeat(ABOUT_MAX + 1), website: "http://x.se", facebook: "", instagram: "https://evil.com/x" });
    const PROFILE_ERRORS = profileErrors();
    expect(r).toEqual({ ok: false, errors: { about: PROFILE_ERRORS.about, website: PROFILE_ERRORS.website, instagram: PROFILE_ERRORS.instagram } });
  });

  it("round-trips through the form", () => {
    const saved = { about: "Hej", website_url: "https://exempel.se/", facebook_url: "https://facebook.com/x", instagram_url: "https://instagram.com/hooklook" };
    const input = profileInput(saved);
    expect(input.instagram).toBe("@hooklook");
    const again = parseProfile(input);
    expect(again.ok && sameProfile(again.profile, saved)).toBe(true);
    expect(hasProfile(saved)).toBe(true);
    expect(hasProfile({})).toBe(false);
  });
});
