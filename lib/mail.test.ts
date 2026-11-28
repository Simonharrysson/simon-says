import { describe, expect, it, vi } from "vitest";
import { resendMailer, withFromName } from "./mail";

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

describe("resendMailer outcomes", () => {
  const msg = { to: "a@example.com", subject: "S", text: "T", idempotencyKey: "invite-x-0" };
  const mailer = (fetchFn: () => Promise<Response>) => resendMailer("re_test", "Simon Says <noreply@example.com>", fetchFn as unknown as typeof fetch);
  it("sends the Idempotency-Key header; 2xx sent, 4xx failed, 5xx and timeouts uncertain", async () => {
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await mailer(ok).sendWithOutcome!(msg)).toBe("sent");
    expect(((ok.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>)["idempotency-key"]).toBe("invite-x-0");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await mailer(async () => new Response("{}", { status: 422 })).sendWithOutcome!(msg)).toBe("failed");
    expect(await mailer(async () => new Response("{}", { status: 503 })).sendWithOutcome!(msg)).toBe("uncertain");
    expect(await mailer(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }).sendWithOutcome!(msg)).toBe("uncertain");
    expect(await mailer(async () => new Response("{}", { status: 503 })).send(msg)).toBe(false);
    expect(err.mock.calls.flat().join(" ")).not.toMatch(/a@example\.com/);
    err.mockRestore();
  });
});

describe("withFromName (0063: \"Johanna via Simon Says\")", () => {
  it("swaps the display name, keeps our address, strips header tricks", () => {
    expect(withFromName("Simon Says <noreply@harrysson.co>", "Johanna via Simon Says")).toBe('"Johanna via Simon Says" <noreply@harrysson.co>');
    expect(withFromName("noreply@harrysson.co", 'Ev"il <x@y>\r\nBcc: z')).toBe('"Evil x@yBcc: z" <noreply@harrysson.co>');
    expect(withFromName("Simon Says <noreply@harrysson.co>", undefined)).toBe("Simon Says <noreply@harrysson.co>");
  });
});
