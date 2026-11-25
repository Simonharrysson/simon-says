import { describe, expect, it } from "vitest";
import { sessionCookieOptions } from "./cookie-options";

describe("sessionCookieOptions", () => {
  it("is httpOnly always and Secure in production", () => {
    expect(sessionCookieOptions("production")).toEqual({ httpOnly: true, secure: true, sameSite: "lax" });
    expect(sessionCookieOptions("development")).toMatchObject({ httpOnly: true, secure: false });
  });
});
