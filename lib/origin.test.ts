import { describe, expect, it } from "vitest";
import { originFrom } from "./origin";

describe("originFrom", () => {
  it("prefers the forwarded host and proto", () => {
    const h = new Headers({ host: "internal", "x-forwarded-host": "simonsays.harrysson.co", "x-forwarded-proto": "https" });
    expect(originFrom(h)).toBe("https://simonsays.harrysson.co");
  });
  it("uses http for localhost without a forwarded proto", () => {
    expect(originFrom(new Headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
  });
});
