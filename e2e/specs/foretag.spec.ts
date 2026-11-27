import type { Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_EMAIL } from "../env";
import { ensureUser, expect, expectAccessible, fake, test } from "../fixtures";

// Företag (0050): the CEO (an allowed creator) creates a company and builds the tree in the UI,
// a developer starts a meeting for Utveckling, and visibility follows the tree: the developer and
// the head above see it, a Kommunikation member (a cousin) never does, the CEO sees everything.
// The customer page lists the meetings with a customer and their open tasks. A task from a CEO
// meeting for someone at the bottom waits for approval, and then reaches them as the task only.

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

interface Company {
  id: string;
  url: string;
  groups: Record<"root" | "heads" | "dev" | "com", string>;
}

/** The CEO creates the company and its tree through the UI; the three colleagues join (as an invite would) and are placed in the UI. */
async function buildCompany(page: Page, db: SupabaseClient, people: { dev: string; head: string; com: string }): Promise<Company> {
  const name = `Testbolag ${Date.now().toString(36)}`;
  await page.goto("/orgs");
  const create = page.getByRole("region", { name: "Skapa ett företag" });
  await create.getByLabel("Företagets namn").fill(name);
  await create.getByRole("button", { name: "Skapa företag" }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}\?flik=personer$/, { timeout: 30_000 });
  const id = new URL(page.url()).pathname.split("/")[2];
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  const groupId = async (group: string) =>
    (must(group, await db.from("groups").select("id").eq("org_id", id).eq("name", group).single()) as { id: string }).id;
  const addGroup = async (group: string, under: string) => {
    const form = page.getByRole("region", { name: "Ny grupp" });
    await form.locator("#group-name").fill(group);
    await form.getByLabel("Under").selectOption(await groupId(under));
    await form.getByRole("button", { name: "Lägg till" }).click();
    await expect(page.getByRole("heading", { name: group, level: 3 })).toBeVisible({ timeout: 15_000 });
  };
  await addGroup("Avdelningschefer", "Ledning");
  await addGroup("Utveckling", "Avdelningschefer");
  await addGroup("Kommunikation", "Avdelningschefer");
  await expectAccessible(page);

  // The colleagues join (the invite link's join_org), then show up under "Utan plats".
  const ids = await Promise.all([ensureUser(db, people.dev), ensureUser(db, people.head), ensureUser(db, people.com)]);
  must("join", await db.from("org_members").insert(ids.map((user_id) => ({ org_id: id, user_id, role: "member" }))));
  await page.reload();
  const place = async (email: string, group: string) => {
    await page.getByLabel(`Placera ${email}`).selectOption(await groupId(group));
    // Placed: the account now has a person row in the group, listed by name there.
    await expect(page.getByLabel(`Placera ${email}`)).toHaveCount(0, { timeout: 15_000 });
  };
  await place(people.dev, "Utveckling");
  await place(people.head, "Avdelningschefer");
  await place(people.com, "Kommunikation");

  const g = groupId;
  return { id, url: `/orgs/${id}`, groups: { root: await g("Ledning"), heads: await g("Avdelningschefer"), dev: await g("Utveckling"), com: await g("Kommunikation") } };
}

test("Företag: create, build the tree, start a meeting for Utveckling, visibility per level, customer page", async ({ db, signedIn, newEmail }) => {
  test.setTimeout(240_000);
  const people = { dev: newEmail("utvecklare"), head: newEmail("kommchef"), com: newEmail("kommunikator") };
  const { page: ceo } = await signedIn(ADMIN_EMAIL, "/orgs");
  const company = await buildCompany(ceo, db, people);

  // The developer starts a meeting; "Möte för" is their own group.
  const { page: dev } = await signedIn(people.dev, company.url);
  await expect(dev.getByText("Du ser möten för Utveckling, alla grupper under den och hela företaget.")).toBeVisible();
  await dev.getByRole("link", { name: "Starta möte", exact: true }).click();
  await expect(dev.getByRole("heading", { name: "Innan ni börjar" })).toBeVisible();
  await expect(dev.getByLabel("Möte för")).toHaveValue(company.groups.dev);
  await expect(dev.getByText("Ser mötet: Utveckling, grupperna ovanför och admins.")).toBeVisible();
  const consent = dev.getByRole("checkbox", { name: "Alla i rummet vet att mötet transkriberas och kan be om paus" });
  await expect(async () => {
    await consent.check({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expectAccessible(dev);
  await dev.getByRole("button", { name: "Starta mötet" }).click();
  await expect(dev.getByRole("heading", { name: "Namnrunda" })).toBeVisible({ timeout: 30_000 });
  const meetingId = dev.url().split("/").at(-1)!;
  await dev.getByRole("button", { name: "Klar, alla har sagt sitt namn" }).click();
  await expect(dev.getByRole("heading", { name: "Namnrunda" })).toHaveCount(0, { timeout: 30_000 });
  await dev.getByRole("button", { name: "Avsluta", exact: true }).click();
  await dev.getByRole("dialog", { name: "Avsluta mötet?" }).getByRole("button", { name: "Avsluta mötet" }).click();
  await expect(dev.getByRole("heading", { name: "Mötet är avslutat" })).toBeVisible({ timeout: 60_000 });

  const row = must("meeting", await db.from("meetings").select("group_id, private, doc_id, status").eq("id", meetingId).single()) as {
    group_id: string;
    private: boolean;
    doc_id: string;
    status: string;
  };
  expect(row).toMatchObject({ group_id: company.groups.dev, private: false, status: "done" });
  // The Doc went only to people who can see the meeting: the head and the CEO, never the cousin.
  const shared = (await fake.doc(row.doc_id))?.permissions ?? [];
  expect(shared).toEqual(expect.arrayContaining([people.head, ADMIN_EMAIL]));
  expect(shared).not.toContain(people.com);

  const sees = async (page: Page, yes: boolean) => {
    await page.goto(company.url);
    const link = page.locator(`a[href="/orgs/${company.id}/mote/${meetingId}"]`);
    if (yes) await expect(link).toBeVisible();
    else await expect(link).toHaveCount(0);
  };
  await sees(dev, true);
  const { page: head } = await signedIn(people.head, company.url);
  await sees(head, true);
  await sees(ceo, true);
  const { page: com } = await signedIn(people.com, company.url);
  await sees(com, false);
  await com.goto(`/orgs/${company.id}/mote/${meetingId}`);
  await expect(com.getByRole("heading", { name: "Här finns ingenting" })).toBeVisible();
  await expectAccessible(com);
  // Nor the live page or the meeting's APIs (they read the meeting as the caller first: RLS).
  await com.goto(`/meetings/${meetingId}`);
  await expect(com.getByRole("heading", { name: "Här finns ingenting" })).toBeVisible();
  expect((await com.request.post(`/api/meetings/${meetingId}/token`, { data: {} })).status()).toBe(404);
  expect((await com.request.post(`/api/meetings/${meetingId}/end`, { data: {} })).status()).toBe(404);
  expect((await com.request.get(`/api/meetings/${meetingId}/tasks`)).status()).toBe(404);
  // Förening-only features don't exist for a company (they would read around the tree).
  await com.goto(`/orgs/${company.id}/forbered`);
  await expect(com.getByRole("heading", { name: "Här finns ingenting" })).toBeVisible();
  expect((await com.request.get(`/api/orgs/${company.id}/prepare`)).status()).toBe(404);

  // The customer page: a meeting with Acme (found from a guest's domain) and its open task.
  const devId = await ensureUser(db, people.dev);
  const acme = must("customer", await db.rpc("customer_for_domain", { p_org_id: company.id, p_domain: "acme.se", p_name: "Acme" })) as string;
  const doc = await fake.createDoc({ name: "Kundmöte Acme", owner: people.dev });
  const acmeMeeting = (must(
    "acme meeting",
    await db
      .from("meetings")
      .insert({ org_id: company.id, started_by: devId, doc_id: doc.id, notes_tab_id: "t.0", status: "done", group_id: company.groups.dev, context_id: acme, started_at: new Date(Date.now() - 86_400_000).toISOString() })
      .select("id")
      .single(),
  ) as { id: string }).id;
  must("acme task", await db.from("note_items").insert({ meeting_id: acmeMeeting, id: "a1", section: "action", kind: "task", text: "Skicka offert till Acme", owner: "Utvecklaren", due: "fredag" }));
  await ceo.goto(`${company.url}?flik=kunder`);
  await ceo.getByRole("link", { name: /Acme/ }).click();
  await expect(ceo.getByRole("heading", { name: "Acme", level: 1 })).toBeVisible();
  await expect(ceo.getByText("Hittad från acme.se")).toBeVisible();
  await expect(ceo.getByText("Skicka offert till Acme")).toBeVisible();
  await expectAccessible(ceo);
  // The cousin sees the customer but none of Utveckling's meetings with it.
  await com.goto(`/orgs/${company.id}/kund/${acme}`);
  await expect(com.getByText("Du ser inga möten med kunden.")).toBeVisible();
  await expect(com.getByText("Skicka offert till Acme")).toHaveCount(0);
});

test("Företag: a task from a CEO meeting waits for approval, then reaches its owner as the task only @phone", async ({ db, signedIn, newEmail }) => {
  test.setTimeout(180_000);
  // A fresh CEO and company of its own (the tree is built in the UI in the test above), so parallel
  // runs and retries never share an approver's list.
  const ceoEmail = newEmail("vd");
  const comEmail = newEmail("kommunikator");
  const [ceoId, comId] = await Promise.all([ensureUser(db, ceoEmail), ensureUser(db, comEmail)]);
  const companyId = must("company", await db.rpc("create_foretag", { p_user: ceoId, p_name: `Ledningsbolag ${Date.now().toString(36)}`, p_root_name: "Ledning", p_person_name: "Vera Vd" })) as string;
  const root = (must("root", await db.from("groups").select("id").eq("org_id", companyId).single()) as { id: string }).id;
  const comGroup = (must("com", await db.from("groups").insert({ org_id: companyId, name: "Kommunikation", parent_group_id: root }).select("id").single()) as { id: string }).id;
  must("member", await db.from("org_members").insert({ org_id: companyId, user_id: comId, role: "member" }));
  const comPerson = (must("person", await db.from("people").insert({ org_id: companyId, name: "Kim Kommunikatör", member_user_id: comId, group_id: comGroup }).select("id").single()) as { id: string }).id;
  const company = { id: companyId, groups: { root } };
  const people = { com: comEmail };
  const { page: ceo } = await signedIn(ceoEmail, "/hem");
  const doc = await fake.createDoc({ name: "Ledningsmöte", owner: ceoEmail });
  const meeting = (must(
    "ceo meeting",
    await db
      .from("meetings")
      .insert({ org_id: company.id, started_by: ceoId, doc_id: doc.id, notes_tab_id: "t.0", status: "done", group_id: company.groups.root, summary_state: "off" })
      .select("id")
      .single(),
  ) as { id: string }).id;
  must(
    "ceo notes",
    await db.from("note_items").insert([
      { meeting_id: meeting, id: "h1", section: "action", kind: "task", text: "Förbered nedskärningen i Kommunikation", owner_person_id: comPerson, due: "fredag" },
      { meeting_id: meeting, id: "h2", section: "decision", kind: "decision", text: "Hemligt ledningsbeslut" },
    ]),
  );
  // What the summary run does first for a Företag meeting.
  expect(must("handoffs", await db.rpc("create_task_handoffs", { p_meeting_id: meeting }))).toBe(1);

  // Pending: the owner sees nothing yet.
  const { page: com } = await signedIn(people.com, "/hem");
  await expect(com.getByRole("heading", { name: "Mina uppgifter" })).toBeVisible();
  await expect(com.getByText(/nedskärningen/)).toHaveCount(0);

  // The CEO reviews the wording and sends it.
  await ceo.goto("/hem");
  const approvals = ceo.getByRole("region", { name: /Väntar på godkännande/ });
  await expect(approvals).toBeVisible();
  await expect(approvals.getByText("Till Kim Kommunikatör")).toBeVisible();
  await expectAccessible(ceo);
  const text = approvals.getByLabel("Uppgiften som Kim Kommunikatör får se");
  await text.fill("Ta fram siffror för Kommunikation till fredag");
  await approvals.getByRole("button", { name: "Godkänn och skicka" }).click();
  // Sent: the list refreshes without it (nothing else waits).
  await expect(ceo.getByRole("region", { name: /Väntar på godkännande/ })).toHaveCount(0, { timeout: 15_000 });

  // The owner: the reviewed task, who gave it and when; no meeting title, link, notes or Doc.
  await com.reload();
  const task = com.getByRole("list", { name: /uppgifter/i }).getByRole("listitem").filter({ hasText: "Ta fram siffror för Kommunikation till fredag" });
  await expect(task).toBeVisible();
  await expect(task).toContainText("Från Vera Vd");
  await expect(task.locator("a")).toHaveCount(0);
  await expect(com.getByText(/nedskärningen|Hemligt ledningsbeslut|Ledningsmöte/)).toHaveCount(0);
  await expectAccessible(com);
  await com.goto(`/orgs/${company.id}/mote/${meeting}`);
  await expect(com.getByRole("heading", { name: "Här finns ingenting" })).toBeVisible();
});
