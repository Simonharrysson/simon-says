import { beforeAll, describe, expect, it } from "vitest";
import { useTestEnv } from "@/test/env";

beforeAll(useTestEnv);
const { checkTicket, fileTicket, TICKET_SECONDS } = await import("./ticket");

describe("import tickets", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  it("a ticket opens exactly its file, for its user and förening, until it expires", () => {
    const t = fileTicket("u1", "org1", "1DocAAAAAAAA", now);
    expect(checkTicket(t, "u1", "org1", "1DocAAAAAAAA", now)).toBe(true);
    expect(checkTicket(t, "u1", "org1", "1DocBBBBBBBB", now)).toBe(false);
    expect(checkTicket(t, "u2", "org1", "1DocAAAAAAAA", now)).toBe(false);
    expect(checkTicket(t, "u1", "org2", "1DocAAAAAAAA", now)).toBe(false);
    expect(checkTicket(t, "u1", "org1", "1DocAAAAAAAA", now + (TICKET_SECONDS + 1) * 1000)).toBe(false);
  });
  it("forged or malformed tickets fail", () => {
    const t = fileTicket("u1", "org1", "1DocAAAAAAAA", now);
    const later = `${Number(t.split(".")[0]) + 3600}.${t.split(".")[1]}`;
    expect(checkTicket(later, "u1", "org1", "1DocAAAAAAAA", now)).toBe(false);
    for (const bad of [undefined, "", "x", "1.abc", 42]) expect(checkTicket(bad, "u1", "org1", "1DocAAAAAAAA", now)).toBe(false);
  });
});
