import { describe, expect, it, vi } from "vitest";
import { resendMailer } from "./mail";

describe("resendMailer", () => {
  it("passes html and reply_to only when given", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const mailer = resendMailer("re_test", "Simon Says <noreply@example.com>", fetchFn as unknown as typeof fetch);
    await mailer.send({ to: "a@example.com", subject: "S", text: "T" });
    await mailer.send({ to: "a@example.com", subject: "S", text: "T", html: "<p>T</p>", replyTo: "admin@example.com" });
    const bodies = fetchFn.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0]).toEqual({ from: "Simon Says <noreply@example.com>", to: ["a@example.com"], subject: "S", text: "T" });
    expect(bodies[1]).toMatchObject({ html: "<p>T</p>", reply_to: "admin@example.com" });
  });
});
