import { describe, expect, it } from "vitest";
import { globMatch, ROBOTS_MAX_RULES, robotsAllows, robotsRules } from "./robots";

const TOKEN = "simonsaysbot";

describe("robots.txt", () => {
  it("uses the * group and the longest match", () => {
    const rules = robotsRules("User-agent: *\nDisallow: /intern/\nAllow: /intern/publikt\n# kommentar\n", TOKEN);
    expect(robotsAllows(rules, "/")).toBe(true);
    expect(robotsAllows(rules, "/intern/protokoll")).toBe(false);
    expect(robotsAllows(rules, "/intern/publikt/styrelse")).toBe(true);
  });

  it("prefers a group naming our token over *", () => {
    const text = "User-agent: *\nAllow: /\n\nUser-agent: SimonSaysBot\nDisallow: /\n";
    expect(robotsAllows(robotsRules(text, TOKEN), "/styrelse")).toBe(false);
  });

  it("Disallow: / for everyone blocks every page; an empty Disallow blocks nothing", () => {
    expect(robotsAllows(robotsRules("User-agent: *\nDisallow: /\n", TOKEN), "/")).toBe(false);
    expect(robotsAllows(robotsRules("User-agent: *\nDisallow:\n", TOKEN), "/")).toBe(true);
  });

  it("handles * and $ in paths, and groups sharing rules", () => {
    const rules = robotsRules("User-agent: googlebot\nUser-agent: *\nDisallow: /*.pdf$\nDisallow: /sok*\n", TOKEN);
    expect(robotsAllows(rules, "/stadgar.pdf")).toBe(false);
    expect(robotsAllows(rules, "/stadgar.pdf?x=1")).toBe(true);
    expect(robotsAllows(rules, "/soket")).toBe(false);
  });

  it("no rules: everything allowed", () => {
    expect(robotsAllows(robotsRules("", TOKEN), "/x")).toBe(true);
  });

  it("caps the number and length of rules", () => {
    const many = `User-agent: *\n${Array.from({ length: ROBOTS_MAX_RULES + 50 }, (_, i) => `Disallow: /p${i}`).join("\n")}\n`;
    expect(robotsRules(many, TOKEN)).toHaveLength(ROBOTS_MAX_RULES);
    expect(robotsRules(`User-agent: *\nDisallow: /${"x".repeat(600)}\n`, TOKEN)).toHaveLength(0);
  });
});

describe("globMatch", () => {
  it.each([
    ["/a*b", "/axxb", true],
    ["/a*b", "/ab", true],
    ["/a*b", "/axx", false],
    ["/a*b$", "/axxb", true],
    ["/a*b$", "/axxbc", false],
    ["/a*b$", "/abab", true],
    ["/*.pdf$", "/x.pdf", true],
    ["/*.pdf$", "/x.pdfx", false],
    ["/x$", "/x", true],
    ["/x$", "/xy", false],
    ["/a*a$", "/a", false],
    ["*", "/anything", true],
    ["/a**b", "/ab", true],
  ])("%s on %s → %s", (pattern, path, want) => expect(globMatch(pattern, path)).toBe(want));

  it("stays fast on a pathological rule", () => {
    const pattern = `/${"*a".repeat(200)}*b`;
    const path = `/${"a".repeat(100_000)}`;
    const start = performance.now();
    for (let i = 0; i < 10; i++) expect(globMatch(pattern, path)).toBe(false);
    const text = `User-agent: *\n${Array.from({ length: 500 }, () => `Disallow: ${pattern}`).join("\n")}\n`;
    expect(robotsAllows(robotsRules(text, TOKEN), path)).toBe(true);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
