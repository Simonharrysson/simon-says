import { describe, expect, it } from "vitest";
import { resendMailer } from "@/lib/mail";

describe("resendMailer", () => {
  it("forwards extra headers (List-Unsubscribe) to Resend, and omits them when absent", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const mailer = resendMailer("key", "Simon Says <noreply@example.com>", fetchFn);
    const headers = { "List-Unsubscribe": "<https://example.com/x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
    expect(await mailer.send({ to: "a@example.com", subject: "S", text: "T", headers })).toBe(true);
    expect(await mailer.send({ to: "a@example.com", subject: "S", text: "T" })).toBe(true);
    expect(bodies[0].headers).toEqual(headers);
    expect("headers" in bodies[1]).toBe(false);
  });
});
