import { describe, expect, it } from "vitest";
import { navSection } from "./section";

const company = "5f0c1d2e-0000-4000-8000-000000000001";
const forening = "5f0c1d2e-0000-4000-8000-000000000002";

describe("navSection", () => {
  it("marks the plain sections", () => {
    expect(navSection("/hem", [])).toBe("/hem");
    expect(navSection("/privat/inspelning", [])).toBe("/privat");
    expect(navSection("/installningar", [])).toBe("/installningar");
    expect(navSection("/foretag", [])).toBe("/foretag");
    expect(navSection("/orgs", [company])).toBe("/orgs");
  });

  it("puts a company's pages under Företag and a förening's under Föreningar", () => {
    expect(navSection(`/orgs/${company}`, [company])).toBe("/foretag");
    expect(navSection(`/orgs/${company}/kund/abc`, [company])).toBe("/foretag");
    expect(navSection(`/orgs/${forening}`, [company])).toBe("/orgs");
    expect(navSection(`/orgs/${forening}/protokoll`, [company])).toBe("/orgs");
  });

  it("matches whole segments only", () => {
    expect(navSection("/hemma", [])).toBeUndefined();
    expect(navSection("/orgsx", [])).toBeUndefined();
    expect(navSection("/", [])).toBeUndefined();
  });
});
