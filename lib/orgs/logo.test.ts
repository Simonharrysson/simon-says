import { describe, expect, it } from "vitest";
import { logoUrl, sniffImage, squareCrop } from "./logo";

describe("logo helpers", () => {
  it("crops the centred square", () => {
    expect(squareCrop(400, 200)).toEqual({ sx: 100, sy: 0, size: 200 });
    expect(squareCrop(300, 501)).toEqual({ sx: 0, sy: 100, size: 300 });
    expect(squareCrop(64, 64)).toEqual({ sx: 0, sy: 0, size: 64 });
  });

  it("versions the URL and has none without a logo", () => {
    expect(logoUrl("o1", null)).toBeNull();
    const a = logoUrl("o1", "2026-11-26T10:00:00Z");
    const b = logoUrl("o1", "2026-11-26T10:00:01Z");
    expect(a).toMatch(/^\/api\/orgs\/o1\/logo\?v=/);
    expect(a).not.toBe(b);
  });

  it("knows PNG, JPEG and WebP by their bytes, nothing else", () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe("image/png");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("<svg xmlns=…>"))).toBeNull();
    expect(sniffImage(new Uint8Array([]))).toBeNull();
  });
});
