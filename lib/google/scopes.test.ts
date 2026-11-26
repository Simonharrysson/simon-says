import { describe, expect, it } from "vitest";
import { DRIVE_FILE, fetchGrantedScope, GOOGLE_SCOPES, hasDriveFile } from "./scopes";

describe("hasDriveFile", () => {
  it("is true when drive.file was granted", () => {
    expect(hasDriveFile("openid email https://www.googleapis.com/auth/drive.file")).toBe(true);
  });

  it("is false without it", () => {
    expect(hasDriveFile("openid email profile")).toBe(false);
  });

  it("does not accept a prefix match such as drive.file.readonly", () => {
    expect(hasDriveFile("https://www.googleapis.com/auth/drive.filex")).toBe(false);
  });

  it("is false for an empty scope", () => {
    expect(hasDriveFile("")).toBe(false);
  });
});

describe("GOOGLE_SCOPES", () => {
  it("is exactly openid email profile drive.file", () => {
    expect(GOOGLE_SCOPES).toEqual(["openid", "email", "profile", DRIVE_FILE]);
  });
});

describe("fetchGrantedScope", () => {
  it("returns Google's scope string for the token", async () => {
    const fetchImpl = (async () =>
      Response.json({ scope: `openid ${DRIVE_FILE}`, expires_in: 3599 })) as typeof fetch;
    await expect(fetchGrantedScope("ya29.x", fetchImpl)).resolves.toBe(`openid ${DRIVE_FILE}`);
  });

  it("returns null when Google rejects the token", async () => {
    const fetchImpl = (async () =>
      Response.json({ error: "invalid_token" }, { status: 400 })) as typeof fetch;
    await expect(fetchGrantedScope("bad", fetchImpl)).resolves.toBeNull();
  });
});

describe("hasDriveReadonly", () => {
  it("is true only for the exact drive.readonly scope", async () => {
    const { hasDriveReadonly, DRIVE_READONLY } = await import("./scopes");
    expect(hasDriveReadonly(`openid ${DRIVE_FILE} ${DRIVE_READONLY}`)).toBe(true);
    expect(hasDriveReadonly(`openid ${DRIVE_FILE}`)).toBe(false);
    expect(hasDriveReadonly("https://www.googleapis.com/auth/drive.readonlyx")).toBe(false);
    expect(hasDriveReadonly(null)).toBe(false);
  });

  it("the import asks for the sign-in scopes plus drive.readonly; sign-in never asks for it", async () => {
    const { IMPORT_SCOPES, DRIVE_READONLY } = await import("./scopes");
    expect(IMPORT_SCOPES).toEqual([...GOOGLE_SCOPES, DRIVE_READONLY]);
    expect(GOOGLE_SCOPES).not.toContain(DRIVE_READONLY);
  });
});
