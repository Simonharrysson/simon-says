import { describe, expect, it } from "vitest";
import { designPreviewEnabled } from "./design-guard";

describe("designPreviewEnabled", () => {
  it("is on in development and test", () => {
    expect(designPreviewEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(designPreviewEnabled({ NODE_ENV: "test" })).toBe(true);
  });
  it("is off in production by default", () => {
    expect(designPreviewEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(designPreviewEnabled({ NODE_ENV: "production", DESIGN_PREVIEW: "0" })).toBe(false);
    expect(designPreviewEnabled({ NODE_ENV: "production", DESIGN_PREVIEW: "true" })).toBe(false);
  });
  it("can be switched on in production with DESIGN_PREVIEW=1", () => {
    expect(designPreviewEnabled({ NODE_ENV: "production", DESIGN_PREVIEW: "1" })).toBe(true);
  });
});
