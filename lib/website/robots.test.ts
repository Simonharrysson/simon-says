import { describe, expect, it } from "vitest";
import { robotsAllows, robotsRules } from "./robots";

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
});
