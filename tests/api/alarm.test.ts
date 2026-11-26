import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Task 12: heartbeat stop ends the meeting, summary cost math, the ⚠️ threshold, the once-per-day
// 50 % email, the Resend sender and the cron route. No database needed: the service-role client
// is a small fake, and the once-per-day claim is the SQL function's job (tested via a fake).

const envState = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  return { ...mod, getEnv: () => ({ ...mod.parseEnv({ ...testEnv }), ...envState.over }) };
});

const fake = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  failedCount: 0,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const result = () =>
        table === "meeting_events"
          ? { data: null, count: fake.failedCount, error: null }
          : { data: fake.tables[table] ?? [], error: null };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "lt", "update"]) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown) => res(result());
      return b;
    },
  }),
}));

const limitsState = vi.hoisted(() => ({ result: { ok: true, warn: false, stop: false, remainingSeconds: 100 } as Record<string, unknown> }));
vi.mock("@/lib/limits", () => ({ checkLimits: async () => limitsState.result }));
const ended = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("@/lib/meetings/tick", () => ({
  endMeeting: async (id: string) => {
    ended.ids.push(id);
    return "done";
  },
}));
const afterQueue = vi.hoisted(() => ({ fns: [] as (() => unknown)[] }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => afterQueue.fns.push(fn),
}));
const supa = vi.hoisted(() => ({ meeting: { id: "m1", org_id: "o1", started_by: "u1", status: "live" } }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) b[m] = () => b;
      // org_members: the caller is a member (any member may run the meeting).
      b.maybeSingle = async () => ({ data: table === "org_members" ? { role: "member" } : supa.meeting, error: null });
      return b;
    },
  }),
}));

const alarm = await import("@/lib/alarm");
const { resendMailer } = await import("@/lib/mail");
const { POST: heartbeat } = await import("@/app/api/meetings/[id]/heartbeat/route");
const { GET: cron } = await import("@/app/api/cron/alarm/route");

beforeEach(() => {
  envState.over = {};
  fake.tables = {};
  fake.failedCount = 0;
  ended.ids = [];
  afterQueue.fns = [];
  limitsState.result = { ok: true, warn: false, stop: false, remainingSeconds: 100 };
});

describe("heartbeat stop ends the meeting", () => {
  const beat = () =>
    heartbeat(new NextRequest("https://x.test/api/meetings/m1/heartbeat", { method: "POST" }), {
      params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
    });
  const run = async () => {
    for (const f of afterQueue.fns) await f();
  };

  it("stop: answers { stop: true } and ends the meeting after the response", async () => {
    limitsState.result = { ok: false, warn: false, stop: true, reason: "meeting_length", remainingSeconds: 0 };
    const res = await beat();
    expect(await res.json()).toMatchObject({ warn: false, stop: true, minutesLeft: null });
    await run();
    expect(ended.ids).toEqual(["m1"]);
  });

  it("warn: only warns, nothing ends", async () => {
    limitsState.result = { ok: true, warn: true, stop: false, remainingSeconds: 800 };
    expect(await (await beat()).json()).toMatchObject({ warn: true, stop: false, minutesLeft: 14 });
    await run();
    expect(ended.ids).toEqual([]);
  });

  it("no_consent stop does not end the meeting", async () => {
    limitsState.result = { ok: false, warn: false, stop: true, reason: "no_consent", remainingSeconds: 0 };
    await beat();
    await run();
    expect(ended.ids).toEqual([]);
  });
});

describe("summary", () => {
  const opts = { elevenLabsUsdPerHour: 0.22, dailyUsdCap: 25, failedTicks: 2 };

  it("cost math on a fixed usage_daily row", () => {
    // 10 h at $0.22 = $2.20 ElevenLabs; usd 5.20 in total → Claude $3.00.
    const s = alarm.summarizeDay("2026-11-23", [{ orgName: "A", seconds: 36_000, usd: 5.2 }], opts);
    expect(s.totalHours).toBeCloseTo(10);
    expect(s.elevenLabsUsd).toBeCloseTo(2.2);
    expect(s.claudeUsd).toBeCloseTo(3.0);
    expect(s.usdPerHour).toBeCloseTo(0.52);
    expect(s.exceeded).toBe(false);
  });

  it("adds orgs up; no hours gives no $/h", () => {
    const s = alarm.summarizeDay(
      "d",
      [
        { orgName: "A", seconds: 3600, usd: 1 },
        { orgName: "B", seconds: 7200, usd: 2 },
      ],
      opts,
    );
    expect(s.totalHours).toBeCloseTo(3);
    expect(s.totalUsd).toBeCloseTo(3);
    expect(alarm.summarizeDay("d", [], opts).usdPerHour).toBeNull();
  });

  it("subject starts with ⚠️ only when the day exceeded 50 % of the cap", () => {
    const at = (usd: number) =>
      alarm.summaryMail(alarm.summarizeDay("d", [{ orgName: "A", seconds: 3600, usd }], opts), "a@b.c", 25).subject;
    expect(at(12.5).startsWith("⚠️")).toBe(false); // exactly 50 % is not over
    expect(at(12.51).startsWith("⚠️")).toBe(true);
    expect(at(1).startsWith("⚠️")).toBe(false);
  });

  it("body is Swedish and lists orgs, totals and failed ticks", () => {
    const m = alarm.summaryMail(
      alarm.summarizeDay("2026-11-23", [{ orgName: "Liu AI", seconds: 7200, usd: 3 }], opts),
      "a@b.c",
      25,
    );
    expect(m.text).toContain("Liu AI: 2.00 h");
    expect(m.text).toContain("Misslyckade uppdateringar: 2");
    expect(m.text).toContain("ElevenLabs: $0.44");
  });

  it("yesterdayUtc", () => {
    expect(alarm.yesterdayUtc(new Date("2026-11-24T06:00:00Z"))).toBe("2026-11-23");
  });
});

describe("cron route", () => {
  const call = (auth?: string) =>
    cron(new Request("https://x.test/api/cron/alarm", { headers: auth ? { authorization: auth } : {} }));

  it("401 without the secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
  });

  it("builds yesterday's summary from the database rows (mail unsent without a key)", async () => {
    fake.tables.usage_daily = [{ org_id: "o1", seconds: 3600, usd: 20 }];
    fake.tables.orgs = [{ id: "o1", name: "Org" }];
    fake.failedCount = 4;
    const res = await call("Bearer cron");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ totalUsd: 20, exceeded: true, sent: false });
    expect(body).not.toHaveProperty("retention");
  });
});

describe("immediate 50 % email", () => {
  /** In-memory twin of claim_spend_alarm/mark_spend_alarm_sent: once per day, retry pacing. */
  function deps(spent: number, mailOk = true) {
    const sentMails: string[] = [];
    let sentAt = false;
    let nextAt = 0;
    const clock = { now: 0 };
    return {
      sentMails,
      clock,
      deps: {
        dayUsd: async () => spent,
        claim: async (t: number, retry: number) => {
          if (spent <= t || sentAt || nextAt > clock.now) return false;
          nextAt = clock.now + retry * 1000;
          return true;
        },
        markSent: async () => {
          sentAt = true;
        },
        mailer: {
          send: async (m: { subject: string }) => {
            sentMails.push(m.subject);
            return mailOk;
          },
        },
      },
    };
  }

  it("sends once when the day passes (strictly over) 50 % of GLOBAL_DAILY_USD, not before, not again", async () => {
    envState.over = { GLOBAL_DAILY_USD: 10 };
    for (const spent of [4.99, 5]) {
      const d = deps(spent);
      expect(await alarm.checkSpendAlarm(() => d.deps)).toBe(false);
      expect(d.sentMails).toEqual([]);
    }
    const over = deps(5.01);
    expect(await alarm.checkSpendAlarm(() => over.deps)).toBe(true);
    expect(await alarm.checkSpendAlarm(() => over.deps)).toBe(false);
    expect(await alarm.checkSpendAlarm(() => over.deps)).toBe(false);
    expect(over.sentMails).toHaveLength(1);
    expect(over.sentMails[0]).toMatch(/^⚠️/);
  });

  it("a failed send is retried only after the backoff, not on every update", async () => {
    envState.over = { GLOBAL_DAILY_USD: 10 };
    const d = deps(6, false);
    expect(await alarm.checkSpendAlarm(() => d.deps)).toBe(false);
    expect(await alarm.checkSpendAlarm(() => d.deps)).toBe(false);
    expect(d.sentMails).toHaveLength(1);
    d.clock.now += alarm.ALARM_RETRY_SECONDS * 1000;
    await alarm.checkSpendAlarm(() => d.deps);
    expect(d.sentMails).toHaveLength(2);
  });

  it("never throws, also when building its dependencies fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await alarm.checkSpendAlarm(() => {
        throw new Error("env invalid");
      }),
    ).toBe(false);
    const d = deps(99);
    d.deps.dayUsd = async () => {
      throw new Error("db down");
    };
    expect(await alarm.checkSpendAlarm(() => d.deps)).toBe(false);
    spy.mockRestore();
  });

  it("spendAlarmInBackground defers the check (after) and never throws", () => {
    afterQueue.fns = [];
    expect(() => alarm.spendAlarmInBackground()).not.toThrow();
    expect(afterQueue.fns).toHaveLength(1);
  });
});

describe("resendMailer", () => {
  it("posts to Resend with the key as bearer and reports success", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const ok = await resendMailer("re_key", "Simon Says <noreply@harrysson.co>", f as unknown as typeof fetch).send({
      to: "a@b.c",
      subject: "S",
      text: "T",
    });
    expect(ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_key");
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Simon Says <noreply@harrysson.co>",
      to: ["a@b.c"],
      subject: "S",
      text: "T",
    });
  });

  it("reports false on an error status or a network failure, never logging the key", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bad = vi.fn(async () => new Response("no", { status: 403 }));
    expect(await resendMailer("re_secret", "f", bad as unknown as typeof fetch).send({ to: "a@b.c", subject: "S", text: "T" })).toBe(false);
    const boom = vi.fn(async () => {
      throw new Error("re_secret leaked");
    });
    expect(await resendMailer("re_secret", "f", boom as unknown as typeof fetch).send({ to: "a@b.c", subject: "S", text: "T" })).toBe(false);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("re_secret");
    spy.mockRestore();
  });
});
