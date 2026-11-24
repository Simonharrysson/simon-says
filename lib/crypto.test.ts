import { beforeAll, describe, expect, it } from "vitest";
import { useTestEnv } from "@/test/env";
import { decrypt, encrypt } from "./crypto";

beforeAll(useTestEnv);

describe("crypto", () => {
  it("round-trips", () => {
    const plain = "1//0refresh-token-åäö";
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it("produces different blobs for the same input", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("throws when the ciphertext is tampered with", () => {
    const blob = encrypt("secret");
    const bytes = Buffer.from(blob.slice(3), "base64");
    bytes[bytes.length - 1] ^= 1;
    expect(() => decrypt(`v1:${bytes.toString("base64")}`)).toThrow();
  });

  it("throws on an unknown format", () => {
    expect(() => decrypt("not-a-blob")).toThrow(/format/);
  });
});
