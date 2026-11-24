import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "@/lib/env";

// AES-256-GCM with TOKEN_ENC_KEY. Blob format: "v1:" + base64(iv[12] | tag[16] | ciphertext).
const VERSION = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encrypt(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getEnv().TOKEN_ENC_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return VERSION + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decrypt(blob: string): string {
  if (!blob.startsWith(VERSION)) throw new Error("decrypt: unknown blob format");
  const bytes = Buffer.from(blob.slice(VERSION.length), "base64");
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("decrypt: blob format too short");
  const iv = bytes.subarray(0, IV_BYTES);
  const tag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", getEnv().TOKEN_ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString(
    "utf8",
  );
}
