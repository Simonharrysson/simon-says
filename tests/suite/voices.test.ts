import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import type { EnvOverride } from "@/test/suite-db";

// Feature 3: voices in each förening. The name round maps speaker labels to people of THAT
// förening only; two föreningar that both have an "Anna" never mix; a Testmöte session never
// creates or links people rows; a voice nobody named stays unnamed (the live page asks
// "Vem är detta?" for a speaker whose displayName is null).

const envOverride = vi.hoisted(() => ({}) as EnvOverride);
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  const { testEnv } = await import("@/test/env");
  const base = mod.parseEnv({
    ...testEnv,
    SUPABASE_URL: process.env.LOCAL_SUPABASE_API_URL ?? "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: process.env.LOCAL_SUPABASE_ANON_KEY ?? "anon",
    SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? "service",
  });
  return { ...mod, getEnv: () => ({ ...base, ...envOverride }) };
});

const { extractNames } = await import("@/lib/names/extract");
const { runNameRound } = await import("@/lib/names/round");
const { buildSpeakerList, loadSpeakerView } = await import("@/lib/names/speakers");
const { resolveSpeaker } = await import("@/lib/segments/resolve");
const tick = await import("@/lib/meetings/tick");
const { scriptedClient } = await import("@/test/meeting-sim");
const { createOrg } = await import("@/lib/db/orgs");
const { seedTestSession } = await import("@/lib/testmeeting/feed");
const db = await import("@/test/suite-db");

type Heard = { speaker: string; name: string; needs_confirm?: boolean };
/** A names answer: Claude heard these names for these labels (S1-speaker_k). */
const heard = (list: Heard[]) => () => ({ speakers: list.map((h) => ({ needs_confirm: false, ...h })) });

const nameSeg = (speaker: string, text: string, start_ms: number) => ({ el_session_id: "sess-a", speaker, text, start_ms });

describe("feature: voices (speaker naming per förening)", () => {
  it("the name round snaps a heard first name to the förening's own person only", async () => {
    const segments = [nameSeg("speaker_0", "Hej, det är Anna.", 1000), nameSeg("speaker_1", "Jag heter Omar Said.", 5000)];
    const answer = heard([
      { speaker: "S1-speaker_0", name: "Anna" },
      { speaker: "S1-speaker_1", name: "Omar Said" },
    ]);
    const a = scriptedClient({ names: answer });
    const b = scriptedClient({ names: answer });
    const inA = await extractNames(segments, ["Anna Berg", "Erik Lund"], { client: a.client });
    const inB = await extractNames(segments, ["Anna Lind", "Omar Said"], { client: b.client });
    expect(inA).toEqual([
      { elSessionId: "sess-a", speakerLabel: "speaker_0", name: "Anna Berg", needsConfirm: true },
      { elSessionId: "sess-a", speakerLabel: "speaker_1", name: "Omar Said", needsConfirm: false },
    ]);
    expect(inB).toEqual([
      { elSessionId: "sess-a", speakerLabel: "speaker_0", name: "Anna Lind", needsConfirm: true },
      { elSessionId: "sess-a", speakerLabel: "speaker_1", name: "Omar Said", needsConfirm: false },
    ]);
    // Each call lists its own förening's people only.
    expect(a.calls[0].text).toContain("- Anna Berg");
    expect(a.calls[0].text).not.toContain("Anna Lind");
    expect(b.calls[0].text).not.toContain("Anna Berg");
  });

  it("two people with the same first name in one förening: 'Anna' is not guessed, and needs confirming", async () => {
    const { client } = scriptedClient({ names: heard([{ speaker: "S1-speaker_0", name: "Anna" }]) });
    const out = await extractNames([nameSeg("speaker_0", "Anna här.", 1000)], ["Anna Berg", "Anna Lund"], { client });
    expect(out).toEqual([{ elSessionId: "sess-a", speakerLabel: "speaker_0", name: "Anna", needsConfirm: true }]);
  });

  it("an unnamed voice stays unnamed (displayName null: 'Vem är detta?'); merged labels share one name", () => {
    const sessions = [{ id: "sess-a", started_at: "2026-11-25T17:05:00Z" }];
    const rows = [
      { el_session_id: "sess-a", speaker_label: "speaker_0", display_name: "Anna Berg", person_id: "p-anna" },
      { el_session_id: "sess-a", speaker_label: "speaker_2", display_name: "speaker_2", merged_into_label: "speaker_0" },
      { el_session_id: "sess-a", speaker_label: "speaker_3", display_name: "Erik", needs_confirm: true },
    ];
    const list = buildSpeakerList(
      [
        { el_session_id: "sess-a", speaker: "speaker_0", first_ms: 1000, talk_ms: 4000 },
        { el_session_id: "sess-a", speaker: "speaker_1", first_ms: 2000, talk_ms: 3000 },
        { el_session_id: "sess-a", speaker: "speaker_2", first_ms: 3000, talk_ms: 2000 },
        { el_session_id: "sess-a", speaker: "speaker_3", first_ms: 4000, talk_ms: 1000 },
      ],
      sessions,
      rows,
    );
    expect(list.map((s) => [s.speakerLabel, s.label, s.displayName, s.needsConfirm, s.talkSeconds])).toEqual([
      ["speaker_0", "Talare 1", "Anna Berg", false, 6],
      ["speaker_1", "Talare 2", null, false, 3],
      ["speaker_3", "Talare 4", "Erik", true, 1],
    ]);
    expect(resolveSpeaker(rows, "speaker_2")).toEqual({ label: "speaker_0", displayName: "Anna Berg", personId: "p-anna" });
    // Närvarande lists named voices only, through merges, in first-heard order.
    const seg = (speaker: string, start_ms: number) => ({ el_session_id: "sess-a", segment_index: start_ms, run_index: 0, speaker, text: "hej", start_ms, tick_no: 1, transcript_written_at: null });
    expect(tick.attendeesText(rows, [seg("speaker_1", 500), seg("speaker_2", 900), seg("speaker_3", 2000)], sessions)).toBe("Anna Berg, Erik");
  });
});

describe.skipIf(!hasLocalSupabase)("feature: voices (the name round on the local stack)", () => {
  let starter: TestUser;
  const orgs: { id: string; anna: string }[] = [];

  beforeAll(async () => {
    starter = await createTestUser("suite-voices");
    for (const [name, anna] of [
      ["Röstklubben A", "Anna Berg"],
      ["Röstklubben B", "Anna Lind"],
    ]) {
      const r = await createOrg(starter.db, name);
      if (!r.ok) throw new Error("org");
      const { data, error } = await adminClient()
        .from("people")
        .insert([
          { org_id: r.id, name: anna },
          { org_id: r.id, name: name.endsWith("A") ? "Erik Lund" : "Omar Said" },
        ])
        .select("id, name");
      if (error) throw new Error(error.message);
      orgs.push({ id: r.id, anna: data!.find((p) => p.name === anna)!.id as string });
    }
  });

  beforeEach(() => {
    for (const k of Object.keys(envOverride)) delete envOverride[k as keyof EnvOverride];
    envOverride.GLOBAL_DAILY_HOURS = 1_000_000;
    envOverride.GLOBAL_DAILY_USD = 1_000_000;
  });

  /** A live meeting of `orgId` with one ElevenLabs session (kind live, or test as the Testmöte seeds it). */
  async function meeting(orgId: string, kind: "live" | "test" = "live") {
    const id = randomUUID();
    const { error } = await adminClient().from("meetings").insert({
      id,
      org_id: orgId,
      started_by: starter.id,
      doc_id: `doc-${id}`,
      notes_tab_id: "t.notes",
      status: "live",
      consent_confirmed_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    if (kind === "test") return { id, sessionId: await seedTestSession(id) };
    const sessionId = `el-${randomUUID()}`;
    const { error: se } = await adminClient().from("el_sessions").insert({ id: sessionId, meeting_id: id, max_seconds: 3600 });
    if (se) throw new Error(se.message);
    await adminClient().from("meetings").update({ current_el_session_id: sessionId }).eq("id", id);
    return { id, sessionId };
  }

  const speakerMap = async (id: string) =>
    ((await adminClient().from("speaker_map").select("speaker_label, display_name, person_id, needs_confirm").eq("meeting_id", id).order("speaker_label")).data ?? []);
  const peopleOf = async (orgId: string) => ((await adminClient().from("people").select("name").eq("org_id", orgId).order("name")).data ?? []).map((p) => p.name);

  it("two föreningar with an Anna: each round links its own Anna; the other förening's people are never sent or touched", async () => {
    const answer = heard([
      { speaker: "S1-speaker_0", name: "Anna" },
      { speaker: "S1-speaker_1", name: "Karin Ek" },
    ]);
    const results = [];
    for (const org of orgs) {
      const m = await meeting(org.id);
      await db.say(m.id, m.sessionId, "speaker_0", "Hej, Anna här.", 1000);
      await db.say(m.id, m.sessionId, "speaker_1", "Jag heter Karin Ek.", 4000);
      await db.say(m.id, m.sessionId, "speaker_2", "Mm.", 8000);
      const { client, calls } = scriptedClient({ names: answer });
      const r = await runNameRound({ id: m.id, org_id: org.id }, m.sessionId, { extract: (s, k, o) => extractNames(s, k, { ...o, client }) });
      expect(r.status).toBe("ok");
      results.push({ m, calls, org });
    }
    const [a, b] = results;
    expect(a.calls[0].text).toContain("- Anna Berg");
    expect(a.calls[0].text).not.toContain("Anna Lind");
    expect(b.calls[0].text).toContain("- Anna Lind");
    expect(b.calls[0].text).not.toContain("Anna Berg");
    expect(await speakerMap(a.m.id)).toEqual([
      { speaker_label: "speaker_0", display_name: "Anna Berg", person_id: a.org.anna, needs_confirm: true },
      { speaker_label: "speaker_1", display_name: "Karin Ek", person_id: expect.any(String), needs_confirm: false },
    ]);
    expect((await speakerMap(b.m.id))[0]).toEqual({ speaker_label: "speaker_0", display_name: "Anna Lind", person_id: b.org.anna, needs_confirm: true });
    // A confident new full name joins THAT förening's people; each förening got its own Karin Ek.
    expect(await peopleOf(a.org.id)).toEqual(["Anna Berg", "Erik Lund", "Karin Ek"]);
    expect(await peopleOf(b.org.id)).toEqual(["Anna Lind", "Karin Ek", "Omar Said"]);
    const karinA = (await speakerMap(a.m.id))[1].person_id;
    const { data: karinRow } = await adminClient().from("people").select("org_id").eq("id", karinA).single();
    expect(karinRow?.org_id).toBe(a.org.id);
    // The voice nobody named: on the live page it has no name ("Vem är detta?").
    const view = await loadSpeakerView({ id: a.m.id, org_id: a.org.id, current_el_session_id: a.m.sessionId });
    expect(view.speakers.map((s) => [s.speakerLabel, s.displayName])).toEqual([
      ["speaker_0", "Anna Berg"],
      ["speaker_1", "Karin Ek"],
      ["speaker_2", null],
    ]);
    expect(view.people.map((p) => p.name)).not.toContain("Anna Lind");
  });

  it("a Testmöte session never sends, creates or links people rows", async () => {
    const org = orgs[0];
    const before = await peopleOf(org.id);
    const m = await meeting(org.id, "test");
    await db.say(m.id, m.sessionId, "speaker_0", "Jag heter Anna Berg.", 1000);
    await db.say(m.id, m.sessionId, "speaker_1", "Och jag heter Nils Fiktiv.", 4000);
    const { client, calls } = scriptedClient({
      names: heard([
        { speaker: "S1-speaker_0", name: "Anna Berg" },
        { speaker: "S1-speaker_1", name: "Nils Fiktiv" },
      ]),
    });
    expect((await runNameRound({ id: m.id, org_id: org.id }, m.sessionId, { extract: (s, k, o) => extractNames(s, k, { ...o, client }) })).status).toBe("ok");
    expect(calls[0].text).toContain("Known people in the association (0)");
    expect(await speakerMap(m.id)).toEqual([
      { speaker_label: "speaker_0", display_name: "Anna Berg", person_id: null, needs_confirm: false },
      { speaker_label: "speaker_1", display_name: "Nils Fiktiv", person_id: null, needs_confirm: false },
    ]);
    expect(await peopleOf(org.id)).toEqual(before);
  });
});
