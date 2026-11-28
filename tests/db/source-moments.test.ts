import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";

// Source moments (0069) against the real schema: who may read the transcript behind a decision's
// "▶ 41:52" (a member who can see the meeting, an org that shares its transcript; never a guest,
// an outsider or the Må-runda window), that a source must be a segment of THAT meeting, that the
// page and MCP show nothing when the transcript is hidden, and that save_note_rows keeps the
// columns. Fictional data.

vi.mock("@/lib/supabase/admin", async () => ({ supabaseAdmin: (await import("@/test/local-supabase")).adminClient }));
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  const env = mod.parseEnv({ ...testEnv });
  return { ...mod, getEnv: () => env };
});

const { createOrg, joinOrg } = await import("@/lib/db/orgs");
const { readMoments } = await import("@/lib/meetings/moments");
const { loadOrgMeeting } = await import("@/lib/home/meeting");
const { dbReader } = await import("@/lib/mcp/reader");

const db = () => adminClient();
const must = async <T,>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> => {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
};

describe.skipIf(!hasLocalSupabase)("source moments (0069)", () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let guest: TestUser;
  let orgId: string;
  let otherOrg: string;
  let meetingId: string;
  let otherMeeting: string;
  const session = `el-${randomUUID()}`;
  const otherSession = `el-${randomUUID()}`;

  async function seedMeeting(org: string, by: string, sessionId: string, lines: string[], over: Record<string, unknown> = {}) {
    const m = (await must(
      db()
        .from("meetings")
        .insert({ org_id: org, started_by: by, doc_id: `doc-${randomUUID()}`, notes_tab_id: "t", status: "done", ended_at: new Date().toISOString(), ...over })
        .select("id")
        .single(),
    )) as { id: string };
    await must(db().from("el_sessions").insert({ id: sessionId, meeting_id: m.id, max_seconds: 3600 }));
    await must(db().from("speaker_map").insert({ meeting_id: m.id, el_session_id: sessionId, speaker_label: "speaker_0", display_name: "Karin Sjö" }));
    await must(
      db()
        .from("segments")
        .insert(
          lines.map((text, i) => ({
            meeting_id: m.id,
            el_session_id: sessionId,
            segment_index: i,
            run_index: 0,
            speaker: i % 2 ? "speaker_1" : "speaker_0",
            text,
            start_ms: 60_000 * (i + 1),
            end_ms: 60_000 * (i + 1) + 5000,
            tick_no: 1,
          })),
        ),
    );
    return m.id;
  }

  beforeAll(async () => {
    [owner, member, outsider, guest] = await Promise.all([createTestUser("sm-own"), createTestUser("sm-mem"), createTestUser("sm-out"), createTestUser("sm-guest")]);
    const r = await createOrg(owner.db, "Källföreningen");
    if (!r.ok) throw new Error("org");
    orgId = r.id;
    const code = ((await must(db().from("orgs").select("invite_code").eq("id", orgId).single())) as { invite_code: string }).invite_code;
    expect(await joinOrg(member.db, code)).toBe(orgId);
    const o = await createOrg(outsider.db, "Grannföreningen");
    if (!o.ok) throw new Error("org");
    otherOrg = o.id;
    // Lines 1–8 at 01:00 … 08:00; the Må-runda window covers line 2 (02:00).
    meetingId = await seedMeeting(
      orgId,
      owner.id,
      session,
      ["Välkomna allihop", "Jag mår bra idag", "Nu tar vi budgeten", "Förslag: 12 000 kr", "Vi kör på det", "Anna bokar lokalen", "Till fredag", "Tack för idag"],
      { checkin_window: { startMs: 120_000, endMs: 180_000, closed: true, failures: 0 } },
    );
    otherMeeting = await seedMeeting(otherOrg, outsider.id, otherSession, ["Hemligt i grannföreningen"]);
    const key = (s: string, i: number) => `${s}:${i}:0`;
    await must(
      db()
        .from("note_items")
        .insert([
          { meeting_id: meetingId, id: "n1", section: "decision", text: "Budgeten blir 12 000 kr", position: 0, source_segment_ids: [key(session, 4)], said_at_ms: 300_000 },
          { meeting_id: meetingId, id: "n2", section: "action", text: "Boka lokalen", owner: "Anna", position: 1, source_segment_ids: [key(session, 5), key(session, 6)], said_at_ms: 360_000 },
          // A forged source: a segment of another org's meeting. Never shown.
          { meeting_id: meetingId, id: "n3", section: "decision", text: "Fel källa", position: 2, source_segment_ids: [key(otherSession, 0)], said_at_ms: 60_000 },
          // Inside the Må-runda window: never shown.
          { meeting_id: meetingId, id: "n4", section: "decision", text: "Från må-rundan", position: 3, source_segment_ids: [key(session, 1)], said_at_ms: 120_000 },
          // An old row without sources.
          { meeting_id: meetingId, id: "n5", section: "decision", text: "Gammalt beslut", position: 4 },
        ]),
    );
    await must(db().from("meeting_guests").insert({ meeting_id: meetingId, user_id: guest.id, email: guest.email }));
  });

  const setShare = async (on: boolean) => must(db().from("orgs").update({ share_transcript: on }).eq("id", orgId));

  it("the functions are service-role only; members still can't read segments", async () => {
    for (const u of [owner, member]) {
      expect((await u.db.rpc("transcript_moment_lines", { p_user: u.id, p_meeting_id: meetingId, p_item_ids: ["n1"], p_context: 2 })).error).not.toBeNull();
      expect((await u.db.rpc("transcript_visible", { p_user: u.id, p_meeting_id: meetingId })).error).not.toBeNull();
      expect((await u.db.rpc("transcript_visible_ids", { p_user: u.id, p_ids: [meetingId] })).error).not.toBeNull();
      const { data } = await u.db.from("segments").select("text").eq("meeting_id", meetingId);
      expect(data ?? []).toEqual([]);
    }
  });

  it("a member of a sharing org gets the lines around the moment, the source marked", async () => {
    await setShare(true);
    const m = await readMoments(db(), member.id, meetingId, ["n1", "n2"], 2);
    const n1 = m.get("n1")!;
    // Line 5 (05:00) with two before (03:00, 04:00; 02:00 is the Må-runda) and two after.
    expect(n1.map((l) => [l.atMs, l.source])).toEqual([
      [180_000, false],
      [240_000, false],
      [300_000, true],
      [360_000, false],
      [420_000, false],
    ]);
    expect(n1.find((l) => l.source)).toMatchObject({ text: "Vi kör på det", speaker: "Karin Sjö" });
    expect(m.get("n2")!.filter((l) => l.source).map((l) => l.text)).toEqual(["Anna bokar lokalen", "Till fredag"]);
    // Context 0: the source lines only.
    expect((await readMoments(db(), member.id, meetingId, ["n1"], 0)).get("n1")!.map((l) => l.text)).toEqual(["Vi kör på det"]);
  });

  it("never a wrong line: a foreign segment, the Må-runda window, a row without sources", async () => {
    await setShare(true);
    const m = await readMoments(db(), owner.id, meetingId, ["n3", "n4", "n5"], 3);
    expect(m.size).toBe(0);
    // And nothing of the Må-runda leaks as context either.
    const all = [...(await readMoments(db(), owner.id, meetingId, ["n1", "n2"], 10)).values()].flat();
    expect(all.map((l) => l.text)).not.toContain("Jag mår bra idag");
    expect(all.map((l) => l.text)).not.toContain("Hemligt i grannföreningen");
  });

  it("no excerpt for an outsider, a guest of the meeting, or anyone once the transcript is hidden", async () => {
    await setShare(true);
    expect((await readMoments(db(), outsider.id, meetingId, ["n1"], 2)).size).toBe(0);
    expect((await readMoments(db(), guest.id, meetingId, ["n1"], 2)).size).toBe(0);
    expect(await must(db().rpc("transcript_visible_ids", { p_user: guest.id, p_ids: [meetingId] }))).toEqual([]);
    expect(await must(db().rpc("transcript_visible_ids", { p_user: member.id, p_ids: [meetingId, otherMeeting] }))).toEqual([meetingId]);
    await setShare(false);
    for (const u of [owner, member]) {
      expect((await readMoments(db(), u.id, meetingId, ["n1", "n2"], 2)).size).toBe(0);
      expect(await must(db().rpc("transcript_visible", { p_user: u.id, p_meeting_id: meetingId }))).toBe(false);
    }
    await setShare(true);
  });

  it("the meeting page: ▶ only for verified moments, none when hidden or for a guest", async () => {
    await setShare(true);
    const page = (await loadOrgMeeting(member.db, member.id, orgId, meetingId))!;
    expect(page.decisionItems!.map((d) => [d.itemId, d.saidAtMs])).toEqual([
      ["n1", 300_000],
      ["n3", null],
      ["n4", null],
      ["n5", null],
    ]);
    expect(page.tasks.map((t) => [t.itemId, t.saidAtMs])).toEqual([["n2", 360_000]]);
    await setShare(false);
    const hidden = (await loadOrgMeeting(member.db, member.id, orgId, meetingId))!;
    expect(hidden.decisionItems!.every((d) => d.saidAtMs === null)).toBe(true);
    expect(hidden.tasks.every((t) => t.saidAtMs === null)).toBe(true);
    await setShare(true);
    const asGuest = await loadOrgMeeting(guest.db, guest.id, orgId, meetingId);
    expect(asGuest?.guest).toBe(true);
    expect(asGuest!.decisionItems!.every((d) => d.saidAtMs === null)).toBe(true);
  });

  it("MCP reads the same rule", async () => {
    await setShare(true);
    expect((await dbReader(db(), member.id).moments!(meetingId, ["n1"])).get("n1")!.map((l) => l.text)).toEqual(["Vi kör på det"]);
    expect((await dbReader(db(), outsider.id).moments!(meetingId, ["n1"])).size).toBe(0);
    await setShare(false);
    expect((await dbReader(db(), member.id).moments!(meetingId, ["n1"])).size).toBe(0);
    await setShare(true);
  });

  it("save_note_rows v4 writes the moment, keeps it when a row lacks the key, clears it with null", async () => {
    const lease = randomUUID();
    const m = await seedMeeting(orgId, owner.id, `el-${randomUUID()}`, ["En rad"], { status: "live", tick_lease_id: lease });
    const base = { id: "n1", section: "decision", text: "X", position: 0 };
    const save = (rows: unknown[]) => must(db().rpc("save_note_rows", { p_meeting_id: m, p_lease_id: lease, p_rows: rows }));
    const read = async () => (await must(db().from("note_items").select("source_segment_ids, said_at_ms").eq("meeting_id", m).eq("id", "n1").single())) as { source_segment_ids: string[] | null; said_at_ms: number | null };
    expect(await save([{ ...base, source_segment_ids: ["a:1:0"], said_at_ms: 61_000 }])).toBe(true);
    expect(await read()).toEqual({ source_segment_ids: ["a:1:0"], said_at_ms: 61_000 });
    expect(await save([base])).toBe(true);
    expect(await read()).toEqual({ source_segment_ids: ["a:1:0"], said_at_ms: 61_000 });
    expect(await save([{ ...base, source_segment_ids: null, said_at_ms: null }])).toBe(true);
    expect(await read()).toEqual({ source_segment_ids: null, said_at_ms: null });
  });
});
