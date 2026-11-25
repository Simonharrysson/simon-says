import { describe, expect, it } from "vitest";
import { appOrigin } from "./origin";

describe("appOrigin", () => {
  it("is APP_URL's origin, without a path or trailing slash", () => {
    expect(appOrigin("https://simonsays.harrysson.co/")).toBe("https://simonsays.harrysson.co");
    expect(appOrigin("https://simonsays.harrysson.co/x/y")).toBe("https://simonsays.harrysson.co");
  });
  it("keeps localhost working in dev", () => {
    expect(appOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });
});
