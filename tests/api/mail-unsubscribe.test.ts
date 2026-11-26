import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestEnv } from "@/test/env";

const m = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/email/prefs", () => ({ loadEmailPrefs: m.load, saveAddressEmailPrefs: m.save }));

useTestEnv();
const { POST } = await import("@/app/api/mejl/avsluta/route");
const { saveLinkEmailPrefsAction } = await import("@/app/mejl/actions");
const { emailPrefsToken, oneClickUnsubscribeUrl } = await import("@/lib/email/token");

const post = (url: string) =>
  POST(new Request(url, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } }));

describe("one-click unsubscribe and the /mejl action", () => {
  beforeAll(useTestEnv);
  beforeEach(() => {
    m.load.mockReset().mockResolvedValue({ allOff: false, off: ["invite"] });
    m.save.mockReset().mockResolvedValue(true);
  });

  it("turns off the one category for the signed address, keeping the rest", async () => {
    const res = await post(oneClickUnsubscribeUrl("anna@example.com", "meeting_summary"));
    expect(res.status).toBe(200);
    expect(m.load).toHaveBeenCalledWith({ email: "anna@example.com" });
    expect(m.save).toHaveBeenCalledWith("anna@example.com", { allOff: false, off: ["meeting_summary", "invite"] });
  });

  it("refuses a bad token or category and changes nothing", async () => {
    const good = new URL(oneClickUnsubscribeUrl("anna@example.com", "invite"));
    const badToken = new URL(good);
    badToken.searchParams.set("t", `${good.searchParams.get("t")}x`);
    expect((await post(badToken.toString())).status).toBe(400);
    const badCategory = new URL(good);
    badCategory.searchParams.set("k", "spam");
    expect((await post(badCategory.toString())).status).toBe(400);
    expect(m.save).not.toHaveBeenCalled();
  });

  it("says try again when the database is down", async () => {
    m.load.mockResolvedValue(null);
    expect((await post(oneClickUnsubscribeUrl("anna@example.com", "invite"))).status).toBe(503);
    expect(m.save).not.toHaveBeenCalled();
  });

  it("the page's action saves only for the address in a valid token", async () => {
    const t = emailPrefsToken("erik@example.com");
    expect(await saveLinkEmailPrefsAction(t, { allOff: true, off: ["invite", "spam" as never] })).toBe(true);
    expect(m.save).toHaveBeenCalledWith("erik@example.com", { allOff: true, off: ["invite"] });
    expect(await saveLinkEmailPrefsAction(`${t}x`, { allOff: true, off: [] })).toBe(false);
    expect(await saveLinkEmailPrefsAction(t, { allOff: "yes" } as never)).toBe(false);
    expect(m.save).toHaveBeenCalledTimes(1);
  });
});
