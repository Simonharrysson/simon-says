import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { MailMessage } from "@/lib/mail";
import type { PrivatSummaryAnswer, PrivatSummaryInput, SummarizeFn } from "@/lib/privat/summary";

// 0045: the summary after a Privat recording, against the real schema with a fake Claude and a
// fake mailer (nothing leaves): stored once, tasks kept per context, "Sedan sist" from the open
// tasks, one e-mail through the gate (private_summary), never twice, and retried by the cron.

vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));
const kill = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  const env = mod.parseEnv({ ...testEnv, APP_URL: "https://app.test", GLOBAL_DAILY_USD: "1000000" });
  return { ...mod, getEnv: () => ({ ...env, KILL_SWITCH: kill.on }) };
});

const { ensurePrivatSpace } = await import("@/lib/privat/space");
const { sendMeetingSummaries, sendPendingSummaries } = await import("@/lib/summaries/send");
const { saveMyEmailPrefs } = await import("@/lib/email/prefs");

const answer = (over: Partial<PrivatSummaryAnswer> = {}): PrivatSummaryAnswer => ({
  summary: "Vi gick igenom labb 2.",
  decisions: ["Labb 2 lämnas in på fredag"],
  facts: ["Tentan är 14 januari"],
  tasks: [
    { text: "Skriv inledningen", owner: null, due: "torsdag" },
    { text: "Fixa figurerna", owner: "Anna", due: null },
  ],
  questions: ["Får man ha formelblad?"],
  people: ["Anna"],
  topics: ["labb 2"],
  previous: [],
  ...over,
});

function fakeClaude(next: (input: PrivatSummaryInput) => PrivatSummaryAnswer | "malformed") {
  const calls: PrivatSummaryInput[] = [];
  const summarize: SummarizeFn = async (input) => {
    calls.push(input);
    const a = next(input);
    if (a === "malformed") return { ok: false, reason: "malformed", detail: "x", usage: null };
    return { ok: true, value: a, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0 } };
  };
  return { calls, summarize };
}

function fakeMailer() {
  const sent: MailMessage[] = [];
  return { sent, mailer: { send: async (m: MailMessage) => (sent.push(m), true) } };
}

describe.skipIf(!hasLocalSupabase)("Privat summary (0045)", () => {
  let user: TestUser;
  let space: string;
  let context: string;
  const db = (): SupabaseClient => adminClient();

  async function doneMeeting(minutesAgo: number, notes = true): Promise<string> {
    const started = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const { data, error } = await db()
      .from("meetings")
      .insert({ org_id: space, started_by: user.id, status: "done", context_id: context, started_at: started, ended_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    if (notes) {
      const { error: e } = await db().from("note_items").insert({ meeting_id: data.id, id: "n1", section: "decision", text: "Labb 2 på fredag" });
      if (e) throw new Error(e.message);
    }
    return data.id;
  }

  beforeAll(async () => {
    user = await createTestUser("privsum");
    space = await ensurePrivatSpace(user.db);
    const { data } = await user.db.from("contexts").insert({ org_id: space, name: "TDDE15" }).select("id").single();
    context = data!.id;
  });

  it("first recording: summary stored, tasks in the context, one e-mail to the recorder", async () => {
    const meetingId = await doneMeeting(60);
    const claude = fakeClaude(() => answer());
    const mail = fakeMailer();
    const res = await sendMeetingSummaries(meetingId, { mailer: mail.mailer, now: () => new Date(), summarize: claude.summarize });
    expect(res?.state).toBe("sent");
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]).toMatchObject({ contextName: "TDDE15", locale: "sv", openTasks: [], recentDecisions: [] });
    expect(claude.calls[0].notes).toEqual(["Decision: Labb 2 på fredag"]);

    const { data: s } = await db().from("private_summaries").select("summary, decisions, context_id, mailed").eq("meeting_id", meetingId).single();
    expect(s).toMatchObject({ summary: "Vi gick igenom labb 2.", decisions: ["Labb 2 lämnas in på fredag"], context_id: context, mailed: true });
    const { data: tasks } = await user.db.from("context_tasks").select("text, owner, done").eq("meeting_id", meetingId).order("position");
    expect(tasks).toEqual([
      { text: "Skriv inledningen (torsdag)", owner: null, done: false },
      { text: "Fixa figurerna", owner: "Anna", done: false },
    ]);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(user.email);
    expect(mail.sent[0].subject).toMatch(/^TDDE15: sammanfattning /);
    expect(mail.sent[0].text).toContain("MINA UPPGIFTER\n- Skriv inledningen (torsdag)");
    expect(mail.sent[0].text).toContain(`https://app.test/privat/mote/${meetingId}`);
    expect(mail.sent[0].headers?.["List-Unsubscribe"]).toContain("k=private_summary");

    // Never twice: a second run neither calls Claude nor mails.
    expect(await sendMeetingSummaries(meetingId, { mailer: mail.mailer, now: () => new Date(), summarize: claude.summarize })).toBeNull();
    expect(claude.calls).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
  });

  it("second recording: open tasks go in with ids; Sedan sist marks klart / öppen / inte nämnd and ticks the done one", async () => {
    const meetingId = await doneMeeting(10);
    const claude = fakeClaude((input) => {
      const byText = Object.fromEntries(input.openTasks.map((t) => [t.text, t.key]));
      return answer({
        decisions: [],
        tasks: [{ text: "Plugga kapitel 5", owner: null, due: null }],
        previous: [{ id: byText["Skriv inledningen (torsdag)"], status: "done" }],
      });
    });
    const mail = fakeMailer();
    expect((await sendMeetingSummaries(meetingId, { mailer: mail.mailer, now: () => new Date(), summarize: claude.summarize }))?.state).toBe("sent");
    expect(claude.calls[0].openTasks.map((t) => [t.key, t.text])).toEqual([
      ["t1", "Skriv inledningen (torsdag)"],
      ["t2", "Fixa figurerna"],
    ]);
    expect(claude.calls[0].recentDecisions).toEqual(["Labb 2 lämnas in på fredag"]);

    const { data: s } = await db().from("private_summaries").select("since_last, previous_meeting_id").eq("meeting_id", meetingId).single();
    expect((s!.since_last as { text: string; status: string }[]).map((x) => [x.text, x.status])).toEqual([
      ["Skriv inledningen (torsdag)", "done"],
      ["Fixa figurerna", "not_mentioned"],
    ]);
    expect(s!.previous_meeting_id).not.toBeNull();
    const { data: open } = await user.db.from("context_tasks").select("text").eq("context_id", context).eq("done", false).order("created_at");
    expect(open?.map((t) => t.text)).toEqual(["Fixa figurerna", "Plugga kapitel 5"]);
    expect(mail.sent[0].text).toContain("SEDAN SIST\n- Skriv inledningen (torsdag) — klart\n- Fixa figurerna (Anna) — inte nämnd");
  });

  it("two runs at once (the end hook and the cron): one Claude call, one e-mail", async () => {
    const meetingId = await doneMeeting(7);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const claude = fakeClaude(() => answer({ tasks: [] }));
    const slow: SummarizeFn = async (input, opts) => {
      await gate;
      return claude.summarize(input, opts);
    };
    const mail = fakeMailer();
    const deps = { mailer: mail.mailer, now: () => new Date(), summarize: slow };
    const first = sendMeetingSummaries(meetingId, deps);
    // Let the first run claim and count its attempt before the second one looks.
    await expect.poll(async () => (await db().from("meetings").select("summary_attempts").eq("id", meetingId).single()).data?.summary_attempts).toBe(1);
    expect(await sendMeetingSummaries(meetingId, deps)).toBeNull();
    release();
    expect((await first)?.state).toBe("sent");
    expect(claude.calls).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
  });

  it("a malformed answer is retried by the cron, at most 3 calls, then failed (no e-mail)", async () => {
    const meetingId = await doneMeeting(5);
    const claude = fakeClaude(() => "malformed");
    const mail = fakeMailer();
    const deps = { mailer: mail.mailer, now: () => new Date(), summarize: claude.summarize };
    expect((await sendMeetingSummaries(meetingId, deps))?.state).toBe("sending");
    await sendPendingSummaries(deps, { orgId: space });
    await sendPendingSummaries(deps, { orgId: space });
    await sendPendingSummaries(deps, { orgId: space });
    expect(claude.calls).toHaveLength(3);
    const { data } = await db().from("meetings").select("summary_state, summary_attempts").eq("id", meetingId).single();
    expect(data).toEqual({ summary_state: "failed", summary_attempts: 3 });
    expect(mail.sent).toEqual([]);
  });

  it("under the kill switch nothing is called and the meeting waits for the cron", async () => {
    const meetingId = await doneMeeting(4);
    const claude = fakeClaude(() => answer());
    kill.on = true;
    try {
      expect((await sendMeetingSummaries(meetingId, { mailer: fakeMailer().mailer, now: () => new Date(), summarize: claude.summarize }))?.state).toBe("sending");
    } finally {
      kill.on = false;
    }
    expect(claude.calls).toEqual([]);
    const { data } = await db().from("meetings").select("summary_state, summary_attempts").eq("id", meetingId).single();
    expect(data).toEqual({ summary_state: "sending", summary_attempts: 0 });
    // The cron picks it up once allowed.
    const mail = fakeMailer();
    await sendPendingSummaries({ mailer: mail.mailer, now: () => new Date(), summarize: claude.summarize }, { orgId: space });
    expect(claude.calls).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
  });

  it("nothing recorded: no call, no mail; opted out of the category: stored but not mailed", async () => {
    const empty = await doneMeeting(3, false);
    const claude = fakeClaude(() => answer());
    const mail = fakeMailer();
    expect((await sendMeetingSummaries(empty, { mailer: mail.mailer, now: () => new Date(), summarize: claude.summarize }))?.state).toBe("no_notes");
    expect(claude.calls).toEqual([]);

    expect(await saveMyEmailPrefs(user.db, { allOff: false, off: ["private_summary"] })).toBe(true);
    const meetingId = await doneMeeting(2);
    await sendMeetingSummaries(meetingId, { mailer: mail.mailer, now: () => new Date(), summarize: claude.summarize });
    expect(mail.sent).toEqual([]);
    const { data } = await db().from("private_summaries").select("mailed").eq("meeting_id", meetingId).single();
    expect(data?.mailed).toBe(false);
    await saveMyEmailPrefs(user.db, { allOff: false, off: [] });
  });
});
