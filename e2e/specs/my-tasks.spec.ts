import type { SupabaseClient } from "@supabase/supabase-js";
import { FAKE_URL } from "../env";
import { ensureUser, expect, expectAccessible, fake, seedMeeting, test, type SeededOrg } from "../fixtures";

// Mina uppgifter (/hem): two föreningar and Privat → the home lists only my tasks (by role and by
// name) → tick one → after the 5 s undo it is saved, and the Doc fake shows "✓ klart" on its line.

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

/** Our rendered line in the meeting's Doc: the text plus its named range, as a tick leaves it. */
async function renderLine(docId: string, meetingId: string, itemId: string, text: string) {
  const name = `ss-${meetingId}-${itemId}`;
  const res = await fetch(`${FAKE_URL}/v1/documents/${docId}:batchUpdate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requests: [
        { insertText: { text, location: { index: 1, tabId: "t.0" } } },
        { createNamedRange: { name, range: { tabId: "t.0", startIndex: 1, endIndex: 1 + text.length } } },
      ],
    }),
  });
  if (!res.ok) throw new Error(`fake batchUpdate: ${res.status} ${await res.text()}`);
  return name;
}

async function linkPerson(db: SupabaseClient, org: SeededOrg, name: string, role: string | null, userId: string | null) {
  must("person", await db.from("people").insert({ org_id: org.id, name, role, member_user_id: userId }));
}

test("Mina uppgifter: my tasks from two föreningar and Privat; tick one → ✓ klart in the Doc @phone", async ({ db, seedOrg, signedIn, newEmail }) => {
  test.setTimeout(120_000);
  const email = newEmail("hem");
  const me = await ensureUser(db, email);
  const paddel = await seedOrg({ name: `Paddelklubben ${Date.now().toString(36)}`, members: [email] });
  const film = await seedOrg({ name: `Filmföreningen ${Date.now().toString(36)}`, members: [email] });
  await linkPerson(db, paddel, "Testa Testsson", "Kassör", me);
  await linkPerson(db, paddel, "Anna Berg", "Ordförande", null);
  await linkPerson(db, film, "Testa Testsson", null, me);

  // Paddelklubben: my task by role (rendered in the Doc), and Anna's.
  const line = "Kassör: Boka lokal.";
  const pm = await seedMeeting(db, paddel, { startedBy: email, daysAgo: 2 });
  await renderLine(pm.docId, pm.id, "n1", line);
  must(
    "paddel rows",
    await db.from("note_items").insert([
      { meeting_id: pm.id, id: "n1", section: "action", kind: "task", text: "Boka lokal", owner: "Kassör", position: 0, range_name: `ss-${pm.id}-n1`, last_rendered_text: line },
      { meeting_id: pm.id, id: "n2", section: "action", kind: "task", text: "Skicka inbjudan", owner: "Anna", position: 1 },
      { meeting_id: pm.id, id: "d1", section: "decision", kind: "decision", text: "Vi paddlar i maj", position: 2 },
    ]),
  );
  // Filmföreningen: my task by name.
  const fm = await seedMeeting(db, film, { startedBy: email, daysAgo: 1, items: [{ section: "action", text: "Skicka budget", owner: "Testa" }] });

  // Privat: a context with one task of mine.
  const space = must("privat", await db.from("orgs").insert({ name: "Privat", kind: "privat", created_by: me, share_transcript: false, summary_mode: "off" }).select("id").single()) as { id: string };
  const ctx = must("context", await db.from("contexts").insert({ org_id: space.id, name: "TDDE15" }).select("id").single()) as { id: string };
  const rec = must(
    "privat meeting",
    await db.from("meetings").insert({ org_id: space.id, started_by: me, status: "done", context_id: ctx.id, ended_at: new Date().toISOString() }).select("id").single(),
  ) as { id: string };
  must("privat task", await db.from("context_tasks").insert({ context_id: ctx.id, meeting_id: rec.id, text: "Läsa kap 4" }));

  const { page } = await signedIn(email, "/hem");
  await expect(page.getByRole("heading", { name: "Mina uppgifter", level: 1 })).toBeVisible();
  const list = page.getByRole("list", { name: "Mina uppgifter" });
  await expect(list).toContainText("Boka lokal");
  await expect(list).toContainText("Skicka budget");
  await expect(list).toContainText("Läsa kap 4");
  await expect(list).not.toContainText("Skicka inbjudan");
  await expect(page.getByText("3 öppna uppgifter")).toBeVisible();
  const recent = page.getByRole("list", { name: "Senaste mötena" });
  await expect(recent).toContainText(film.name);
  await expect(recent).toContainText("1 beslut · 2 uppgifter");
  await expectAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "horizontal overflow in px").toBeLessThanOrEqual(0);

  // Undo within 5 s: nothing is saved.
  const budget = page.getByRole("checkbox", { name: "Skicka budget" });
  await expect(async () => {
    await budget.check({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Ångra" }).click();
  await expect(budget).not.toBeChecked();

  // Tick: "Ångra" for 5 s, then saved, and ✓ klart in the Doc.
  await page.getByRole("checkbox", { name: "Boka lokal" }).check();
  await expect(page.getByText("Markerad som klar.")).toBeVisible();
  await expect(page.getByText("Klar, och ”✓ klart” står nu i dokumentet.")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => fake.docText(pm.docId), { message: "✓ klart in the Doc" }).toContain(`${line} ✓ klart`);
  const { data: rows } = await db.from("note_items").select("meeting_id, id, done").in("meeting_id", [pm.id, fm.id]);
  // Both meetings have an "n1": the ticked one is Paddelklubben's.
  expect(rows?.find((r) => r.meeting_id === pm.id && r.id === "n1")?.done).toBe(true);
  expect(rows?.filter((r) => r.done).length).toBe(1);

  // Reloaded: the task is gone from the open list; "Visa klara" shows it.
  await page.reload();
  await expect(page.getByText("2 öppna uppgifter")).toBeVisible();
  await expect(page.getByRole("list", { name: "Mina uppgifter" })).not.toContainText("Boka lokal");
  await page.getByRole("switch", { name: "Visa klara" }).click();
  await expect(page.getByRole("list", { name: "Mina uppgifter" })).toContainText("Boka lokal");

  // The meeting page in the app: decisions and tasks, members only.
  await page.goto(`/orgs/${paddel.id}/mote/${pm.id}`);
  await expect(page.getByRole("heading", { name: "Beslut" })).toBeVisible();
  await expect(page.getByText("Vi paddlar i maj")).toBeVisible();
  await expect(page.getByRole("list", { name: "Uppgifter" })).toContainText("Skicka inbjudan");
  await expect(page.getByRole("checkbox", { name: "Skicka inbjudan" })).toHaveCount(0);
  await expectAccessible(page);
});
