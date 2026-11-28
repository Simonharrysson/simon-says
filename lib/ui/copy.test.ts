import { describe, expect, it } from "vitest";
import { copyText } from "./copy";

describe("copyText", () => {
  it("copies the exact value", async () => {
    let got = "";
    expect(await copyText("https://simonsays.harrysson.co/api/mcp", { writeText: async (v) => void (got = v) })).toBe("copied");
    expect(got).toBe("https://simonsays.harrysson.co/api/mcp");
  });
  it("fails, never throws, when the clipboard refuses or is missing", async () => {
    expect(await copyText("x", { writeText: async () => Promise.reject(new DOMException("denied", "NotAllowedError")) })).toBe("failed");
    expect(await copyText("x", undefined)).toBe("failed");
    expect(await copyText("x", null)).toBe("failed");
    expect(await copyText("x", {} as never)).toBe("failed");
  });
});
