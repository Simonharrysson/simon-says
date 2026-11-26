import { beforeAll, describe, expect, it } from "vitest";
import { testEnv } from "@/test/env";
import { adminClient, createTestUser, hasLocalSupabase, type TestUser } from "@/test/local-supabase";
import { itemRangeName, parseNotesTab } from "@/lib/docs/notes";
import { paragraphsWithRanges, type DocsRequest } from "@/lib/google/docs";
import { apply, docOf, paraEl, TAB } from "@/test/docsim";
import { completeNoteTask, setPrivatTaskDone, type CompleteDeps } from "@/lib/home/complete";
import { loadHome } from "@/lib/home/load";
import { loadOrgMeeting } from "@/lib/home/meeting";
import { ensurePrivatSpace } from "@/lib/privat/space";

// Mina uppgifter (/hem): every read goes through the user's own client, so nobody sees a task
// beyond what membership already shows, and ticking is the owner's (or an admin's) only.

const must = <T,>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

async function seedOrg(name: string, members: { user: TestUser; role: "admin" | "member" }[]) {
  const admin = adminClient();
  const org = must("org", await admin.from("orgs").insert({ name, created_by: null }).select("id").single()) as { id: string };
  must("members", await admin.from("org_members").insert(members.map((m) => ({ org_id: org.id, user_id: m.user.id, role: m.role }))));
  return org.id;
}

async function seedPerson(orgId: string, name: string, role: string | null, user: TestUser | null) {
  return (must("person", await adminClient().from("people").insert({ org_id: orgId, name, role, member_user_id: user?.id ?? null }).select("id").single()) as { id: string }).id;
}

async function seedMeeting(orgId: string, startedBy: string, opts: { status?: string; daysAgo?: number; docId?: string } = {}) {
  const started = new Date(Date.now() - (opts.daysAgo ?? 2) * 86_400_000).toISOString();
  return (
    must(
      "meeting",
      await adminClient()
        .from("meetings")
        .insert({
          org_id: orgId,
          started_by: startedBy,
          doc_id: opts.docId ?? "doc-x",
          notes_tab_id: TAB,
          status: opts.status ?? "done",
          started_at: started,
          ...(opts.status === "live" ? {} : { ended_at: started }),
        })
        .select("id")
        .single(),
    ) as { id: string }
  ).id;
}

const task = (meetingId: string, id: string, over: Record<string, unknown> = {}) => ({
  meeting_id: meetingId,
  id,
  section: "action",
  kind: "task",
  text: `Uppgift ${id}`,
  position: 0,
  ...over,
});

/** A fake Doc behind the Docs calls: our lines with their named ranges. */
function fakeDocs(lines: { name: string; text: string }[]) {
  let doc = docOf([paraEl("Uppgifter", { style: "HEADING_2" })]);
  const end = doc.tabs![0].documentTab!.body!.content!.at(-1)!.endIndex!;
  doc = apply(doc, [{ insertText: { text: "\n", location: { index: end - 1, tabId: TAB } } }]);
  if (lines.length) doc = apply(doc, paragraphsWithRanges(TAB, end, lines));
  const sent: DocsRequest[][] = [];
  const deps: CompleteDeps = {
    admin: adminClient,
    getAuth: async () => ({}) as never,
    readTab: async () => parseNotesTab(doc, TAB),
    batchUpdate: async (_auth, _docId, requests) => {
      sent.push(requests);
    },
  };
  return { deps, sent };
}

describe.skipIf(!hasLocalSupabase)("Mina uppgifter (home)", () => {
  let simon: TestUser; // Kassör in Hook, member of AI
  let anna: TestUser; // member of Hook
  let boss: TestUser; // admin of Hook
  let outsider: TestUser; // only in Other
  let hook: string;
  let ai: string;
  let other: string;
  let m0: string;
  let m1: string;
  let live: string;
  let aiMeeting: string;
  let otherMeeting: string;

  beforeAll(async () => {
    Object.assign(process.env, testEnv, {
      SUPABASE_URL: process.env.LOCAL_SUPABASE_API_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY,
    });
    [simon, anna, boss, outsider] = await Promise.all([createTestUser("mt-simon"), createTestUser("mt-anna"), createTestUser("mt-boss"), createTestUser("mt-out")]);
    hook = await seedOrg("Hook", [
      { user: simon, role: "member" },
      { user: anna, role: "member" },
      { user: boss, role: "admin" },
    ]);
    ai = await seedOrg("AI", [{ user: simon, role: "member" }]);
    other = await seedOrg("Other", [{ user: outsider, role: "admin" }]);
    await seedPerson(hook, "Simon Harr", "Kassör", simon);
    const annaP = await seedPerson(hook, "Anna Berg", "Ordförande", anna);
    await seedPerson(ai, "Simon Harr", null, simon);
    const otherP = await seedPerson(other, "Simon Harr", "Kassör", outsider);

    m0 = await seedMeeting(hook, boss.id, { daysAgo: 9 });
    m1 = await seedMeeting(hook, simon.id, { daysAgo: 2, docId: "doc-m1" });
    live = await seedMeeting(hook, boss.id, { status: "live", daysAgo: 0 });
    aiMeeting = await seedMeeting(ai, simon.id, { daysAgo: 1 });
    otherMeeting = await seedMeeting(other, outsider.id, { daysAgo: 1 });
    const line = "Kassör: Boka lokal.";
    must(
      "rows",
      await adminClient()
        .from("note_items")
        .insert([
          task(m0, "n1", { owner: "Kassör", text: "Boka lokal" }),
          // Carried into m1, rendered in its Doc, with a tasks copy.
          task(m1, "c1", { owner: "Kassör", text: "Boka lokal", carried_from_meeting: m0, carried_from_id: "n1", range_name: itemRangeName(m1, "c1"), last_rendered_text: line }),
          task(m1, "c1-t", { owner: "Kassör", text: "Boka lokal", copy_of: "c1", anchor: "tasks", range_name: itemRangeName(m1, "c1-t"), last_rendered_text: line }),
          task(m1, "n2", { owner: "Anna", owner_person_id: annaP, text: "Skicka inbjudan" }),
          task(m1, "d1", { section: "decision", kind: "decision", text: "Vi kör" }),
          task(live, "n1", { owner: "Simon", text: "Under mötet" }),
          task(aiMeeting, "n1", { owner: "Simon", text: "Skicka budget" }),
          task(otherMeeting, "n1", { owner: "Kassör", owner_person_id: otherP, text: "Annans uppgift" }),
        ]),
    );
  });

  it("lists my tasks only: by role and name, each once, never a live meeting's or another förening's", async () => {
    const home = await loadHome(simon.db, simon.id);
    expect(home.tasks.map((t) => `${t.spaceName}: ${t.text}`).sort()).toEqual(["AI: Skicka budget", "Hook: Boka lokal"]);
    expect(home.tasks.find((t) => t.text === "Boka lokal")).toMatchObject({ meetingId: m1, itemId: "c1" });
    expect(home.recent.map((r) => r.id)).toEqual([aiMeeting, m1, m0]);
    expect(home.recent.find((r) => r.id === m1)).toMatchObject({ decisions: 1, tasks: 2, href: `/orgs/${hook}/mote/${m1}` });
    expect(home.brandNew).toBe(false);
    expect(home.unlinked).toEqual([]);
  });

  it("nobody sees a task beyond their membership", async () => {
    const out = await loadHome(outsider.db, outsider.id);
    expect(out.tasks.map((t) => t.text)).toEqual(["Annans uppgift"]);
    expect(out.recent.every((r) => r.spaceId === other)).toBe(true);
    // Not even the rows: RLS, not the page, keeps them out.
    const { data } = await outsider.db.from("note_items").select("id").eq("meeting_id", m1);
    expect(data).toEqual([]);
    expect(await loadOrgMeeting(outsider.db, outsider.id, hook, m1)).toBeNull();
    // Anna sees her own task, not Simon's.
    expect((await loadHome(anna.db, anna.id)).tasks.map((t) => t.text)).toEqual(["Skicka inbjudan"]);
  });

  it("a user never writes note_items directly", async () => {
    const { data, error } = await simon.db.from("note_items").update({ done: true }).eq("meeting_id", m1).eq("id", "n2").select("id");
    expect(Boolean(error) || (data ?? []).length === 0).toBe(true);
    const { data: row } = await adminClient().from("note_items").select("done").eq("meeting_id", m1).eq("id", "n2").single();
    expect(row?.done).toBe(false);
  });

  it("only the owner or an admin may tick; outsiders get not_found; a live meeting is not_open", async () => {
    const { deps } = fakeDocs([]);
    expect(await completeNoteTask(anna.db, anna.id, m1, "c1", deps)).toEqual({ ok: false, error: "forbidden" });
    expect(await completeNoteTask(outsider.db, outsider.id, m1, "c1", deps)).toEqual({ ok: false, error: "not_found" });
    expect(await completeNoteTask(simon.db, simon.id, live, "n1", deps)).toEqual({ ok: false, error: "not_open" });
    expect(await completeNoteTask(simon.db, simon.id, m1, "d1", deps)).toEqual({ ok: false, error: "not_found" });
    const page = await loadOrgMeeting(simon.db, simon.id, hook, m1);
    expect(page?.tasks.map((t) => [t.itemId, t.canTick]).sort()).toEqual([
      ["c1", true],
      ["n2", false],
    ]);
  });

  it("the owner ticks: row, copy and the carried source done; ✓ klart on our lines; last_rendered_text kept", async () => {
    const line = "Kassör: Boka lokal.";
    const { deps, sent } = fakeDocs([
      { name: itemRangeName(m1, "c1"), text: line },
      { name: itemRangeName(m1, "c1-t"), text: line },
    ]);
    expect(await completeNoteTask(simon.db, simon.id, m1, "c1", deps)).toEqual({ ok: true, doc: "written" });
    expect(sent).toHaveLength(1);
    expect(sent[0].map((r) => r.replaceNamedRangeContent?.text)).toEqual([`${line} ✓ klart`, `${line} ✓ klart`]);
    const { data } = await adminClient().from("note_items").select("meeting_id, id, done, last_rendered_text").in("meeting_id", [m0, m1]).in("id", ["n1", "c1", "c1-t"]);
    const by = (m: string, id: string) => data?.find((r) => r.meeting_id === m && r.id === id);
    expect(by(m1, "c1")).toMatchObject({ done: true, last_rendered_text: `${line} ✓ klart` });
    expect(by(m1, "c1-t")).toMatchObject({ done: true });
    expect(by(m0, "n1")).toMatchObject({ done: true });
    const home = await loadHome(simon.db, simon.id);
    expect(home.tasks.find((t) => t.text === "Boka lokal")?.done).toBe(true);
  });

  it("an admin may tick someone else's; a line a human changed is left alone (locked)", async () => {
    const { deps, sent } = fakeDocs([]);
    // n2 was never rendered (no range): the person is asked to tick it in the Doc.
    expect(await completeNoteTask(boss.db, boss.id, m1, "n2", deps)).toEqual({ ok: true, doc: "locked" });
    expect(sent).toEqual([]);
    const { data } = await adminClient().from("note_items").select("done").eq("meeting_id", m1).eq("id", "n2").single();
    expect(data?.done).toBe(true);
  });

  it("Privat: only the space's own member can tick its tasks", async () => {
    const space = await ensurePrivatSpace(simon.db);
    const ctx = must("context", await simon.db.from("contexts").insert({ org_id: space, name: "TDDE15" }).select("id").single()) as { id: string };
    const pm = must(
      "privat meeting",
      await adminClient().from("meetings").insert({ org_id: space, started_by: simon.id, status: "done", context_id: ctx.id, ended_at: new Date().toISOString() }).select("id").single(),
    ) as { id: string };
    const t = must("task", await adminClient().from("context_tasks").insert({ context_id: ctx.id, meeting_id: pm.id, text: "Läsa kap 4" }).select("id").single()) as { id: string };
    expect((await loadHome(simon.db, simon.id)).tasks.find((x) => x.kind === "privat")).toMatchObject({ itemId: t.id, contextName: "TDDE15" });
    expect((await loadHome(outsider.db, outsider.id)).tasks.some((x) => x.kind === "privat")).toBe(false);
    expect(await setPrivatTaskDone(outsider.db, t.id, true)).toEqual({ ok: false, error: "not_found" });
    expect(await setPrivatTaskDone(simon.db, t.id, true)).toEqual({ ok: true, doc: "none" });
  });

  it("a brand-new user has nothing (the page sends them to Föreningar)", async () => {
    const fresh = await createTestUser("mt-fresh");
    expect(await loadHome(fresh.db, fresh.id)).toMatchObject({ brandNew: true, tasks: [] });
  });
});
