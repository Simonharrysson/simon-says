import { describe, expect, it } from "vitest";
import { customerDomain, customerName, ownDomains } from "./customers";

describe("customerDomain", () => {
  const own = ["harrysson.co"];
  it("the external attendees' domain", () => {
    expect(customerDomain(["simon@harrysson.co", "anna@acme.se", "bo@acme.se"], own)).toBe("acme.se");
  });
  it("never the company's own domain or free mail", () => {
    expect(customerDomain(["simon@harrysson.co", "kalle@gmail.com", "x@outlook.com", "y@hotmail.se"], own)).toBeNull();
    expect(customerDomain([], own)).toBeNull();
  });
  it("the domain with most attendees wins; a tie goes to the first seen", () => {
    expect(customerDomain(["a@beta.se", "b@acme.se", "c@acme.se"], own)).toBe("acme.se");
    expect(customerDomain(["a@beta.se", "b@acme.se"], own)).toBe("beta.se");
  });
  it("case and spaces don't matter; malformed addresses are ignored", () => {
    expect(customerDomain([" Anna@ACME.se ", "nope", "@x"], own)).toBe("acme.se");
  });
  it("a subdomain of the company's own domain is own", () => {
    expect(customerDomain(["a@mail.harrysson.co"], own)).toBeNull();
  });
});

describe("customerName", () => {
  it("names a customer from its domain", () => {
    expect(customerName("acme.se")).toBe("Acme");
    expect(customerName("nordic-tools.com")).toBe("Nordic Tools");
    expect(customerName("mail.acme.co.uk")).toBe("Acme");
    expect(customerName("liu.se")).toBe("Liu");
  });
});

describe("ownDomains", () => {
  it("the members' sign-in domains, without free mail", () => {
    expect(ownDomains(["simon@harrysson.co", "x@gmail.com", "Y@Harrysson.co"])).toEqual(["harrysson.co"]);
  });
});
