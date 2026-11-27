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

/** A full-page screenshot in the report (checked by eye: layout at desktop and 390 px). */
async function snap(page: Page, name: string) {
  await test.info().attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

/** The top rail (five items with Företag) stays on the screen, also at 390 px. Mobile emulation
 * widens the layout viewport to fit an overflow, so measure the last link against the screen. */
async function navFits(page: Page) {
  const width = page.viewportSize()!.width;
  const right = await page
    .getByRole("navigation", { name: "Huvudmeny" })
    .getByRole("link")
    .evaluateAll((links) => Math.max(...links.filter((l) => l.getClientRects().length > 0).map((l) => l.getBoundingClientRect().right)));
  expect(right, "top rail's right edge in px").toBeLessThanOrEqual(width);
}

interface Company {
  id: string;
  url: string;
  groups: Record<"root" | "heads" | "dev" | "com", string>;
}

/** The CEO creates the company and its tree through the UI; the three colleagues join (as an invite would) and are placed in the UI. */
async function buildCompany(page: Page, db: SupabaseClient, people: { dev: string; head: string; com: string }): Promise<Company> {
  const name = `Testbolag ${Date.now().toString(36)}`;
  const nav = page.getByRole("navigation", { name: "Huvudmeny" });
  // A company is not a förening: Föreningar offers no company, Företag (its own top-rail item) does.
  await page.goto("/orgs");
  await expect(page.getByRole("region", { name: "Skapa ett företag" })).toHaveCount(0);
  await nav.getByRole("link", { name: "Företag", exact: true }).click();
  await expect(page).toHaveURL(/\/foretag$/);
  await expect(page.getByRole("heading", { name: "Företag", level: 1 })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Företag", exact: true })).toHaveAttribute("aria-current", "page");
  await expectAccessible(page);
  await navFits(page);
  const create = page.getByRole("region", { name: "Skapa ett företag" });
  await create.getByLabel("Företagets namn").fill(name);
  await create.getByRole("button", { name: "Skapa företag" }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}\?flik=personer$/, { timeout: 30_000 });
  const id = new URL(page.url()).pathname.split("/")[2];
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  // The company's pages keep /orgs/<id> but sit under Företag: the rail marks it, the back link leads there.
  await expect(nav.getByRole("link", { name: "Företag", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Föreningar", exact: true })).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("main").getByRole("link", { name: "Företag", exact: true })).toHaveAttribute("href", "/foretag");
  // Listed under Dina företag, never under Föreningar.
  await page.goto("/foretag");
  await expect(page.getByRole("region", { name: "Dina företag" }).getByRole("link", { name })).toBeVisible();
  await page.goto("/orgs");
  await expect(page.getByRole("link", { name })).toHaveCount(0);
  await expect(page.getByText("Dina företag")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Skapa ett företag" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Föreningar", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto(`/orgs/${id}?flik=personer`);

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
  await snap(page, "personer-och-grupper");

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
  await snap(page, "personer-placerade");

  const g = groupId;
  return { id, url: `/orgs/${id}`, groups: { root: await g("Ledning"), heads: await g("Avdelningschefer"), dev: await g("Utveckling"), com: await g("Kommunikation") } };
}

test("Företag: create, build the tree, start a meeting for Utveckling, visibility per level, customer page @phone", async ({ db, signedIn, newEmail }) => {
  test.setTimeout(240_000);
  const people = { dev: newEmail("utvecklare"), head: newEmail("kommchef"), com: newEmail("kommunikator") };
  const { page: ceo } = await signedIn(ADMIN_EMAIL, "/hem");
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
  await snap(dev, "starta-mote-for");
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
    // In the list (the starter's Nästa möte card links to it too, as the meeting they just ended).
    const link = page.getByRole("region", { name: "Möten" }).locator(`a[href="/orgs/${company.id}/mote/${meetingId}"]`);
    if (yes) await expect(link).toBeVisible();
    else await expect(link).toHaveCount(0);
  };
  await sees(dev, true);
  const { page: head } = await signedIn(people.head, company.url);
  await sees(head, true);
  await sees(ceo, true);
  await snap(ceo, "moten-vd");
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
  await snap(ceo, "kund");
  // The cousin sees no meeting with the customer, so not the customer either (its name tells).
  await com.goto(`/orgs/${company.id}/kund/${acme}`);
  await expect(com.getByRole("heading", { name: "Här finns ingenting" })).toBeVisible();
  await expect(com.getByText("Skicka offert till Acme")).toHaveCount(0);
  // The developer (a member) reads it but can't rename it; renaming is the admins'.
  await dev.goto(`/orgs/${company.id}/kund/${acme}`);
  await expect(dev.getByRole("heading", { name: "Acme", level: 1 })).toBeVisible();
  await expect(dev.getByLabel("Kundens namn")).toHaveCount(0);

  // The CEO moves the head beside Utveckling (into Kommunikation): they no longer see the meeting,
  // so the Doc access Simon Says gave them is taken away (reconciled after the move).
  const headId = await ensureUser(db, people.head);
  const headName = (must("head", await db.from("people").select("name").eq("org_id", company.id).eq("member_user_id", headId).single()) as { name: string }).name;
  await ceo.goto(`${company.url}?flik=personer`);
  await ceo.getByLabel(`Flytta ${headName} till`).selectOption(company.groups.com);
  await expect.poll(async () => (await db.from("people").select("group_id").eq("org_id", company.id).eq("member_user_id", headId).single()).data?.group_id, { timeout: 15_000 }).toBe(company.groups.com);
  await sees(head, false);
  await expect.poll(async () => (await fake.doc(row.doc_id))?.permissions ?? [], { timeout: 30_000 }).not.toContain(people.head);
  expect((await fake.doc(row.doc_id))?.permissions ?? []).toContain(ADMIN_EMAIL);
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
  expect(must("handoffs", await db.rpc("create_task_handoffs", { p_meeting_id: meeting, p_owners: [{ item_id: "h1", person_id: comPerson }] }))).toBe(1);

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
  await snap(ceo, "vantar-pa-godkannande");
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
  await snap(com, "mina-uppgifter-overlamnad");
  await com.goto(`/orgs/${company.id}/mote/${meeting}`);
  await expect(com.getByRole("heading", { name: "Här finns ingenting" })).toBeVisible();
});

test("Företag: the calendar event attaches only when the starter confirms it, with the colleagues they tick @phone", async ({ db, signedIn, newEmail }) => {
  test.setTimeout(180_000);
  // A company of its own: the CEO, the starter and two colleagues, all in Ledning.
  const [ceoEmail, starterEmail, lisaEmail, perEmail, danEmail] = [newEmail("vd"), newEmail("starter"), newEmail("lisa"), newEmail("per"), newEmail("dan")];
  const [ceoId, starterId, lisaId, perId, danId] = await Promise.all([ceoEmail, starterEmail, lisaEmail, perEmail, danEmail].map((e) => ensureUser(db, e)));
  const companyId = must("company", await db.rpc("create_foretag", { p_user: ceoId, p_name: `Kalenderbolag ${Date.now().toString(36)}`, p_root_name: "Ledning", p_person_name: "Vera Vd" })) as string;
  const root = (must("root", await db.from("groups").select("id").eq("org_id", companyId).single()) as { id: string }).id;
  must("members", await db.from("org_members").insert([starterId, lisaId, perId, danId].map((user_id) => ({ org_id: companyId, user_id, role: "member" }))));
  must(
    "people",
    await db.from("people").insert([
      { org_id: companyId, name: "Sam Startare", member_user_id: starterId, group_id: root },
      { org_id: companyId, name: "Lisa Lind", member_user_id: lisaId, group_id: root },
      { org_id: companyId, name: "Per Persson", member_user_id: perId, group_id: root },
      { org_id: companyId, name: "Dan Dahl", member_user_id: danId, group_id: root },
    ]),
  );

  // Happening now in the starter's own calendar: Lisa has accepted, Per hasn't answered, a customer guest.
  const event = {
    id: `ev${crypto.randomUUID().slice(0, 8)}`,
    summary: "Kundmöte Acme",
    start: new Date(Date.now() - 5 * 60_000).toISOString(),
    end: new Date(Date.now() + 55 * 60_000).toISOString(),
    attendees: [
      { email: starterEmail, displayName: "Sam", responseStatus: "accepted" },
      { email: lisaEmail, displayName: "Lisa", responseStatus: "accepted" },
      { email: perEmail, displayName: "Per", responseStatus: "needsAction" },
      { email: danEmail, displayName: "Dan", responseStatus: "declined" },
      { email: "anna@acme.se", displayName: "Anna på Acme", responseStatus: "accepted" },
    ],
  };
  await fake.calendar(starterEmail, { id: starterEmail, summary: "Jobb", primary: true }, [event]);
  const { page } = await signedIn(starterEmail, "/hem");
  // "Koppla kalender" (calendar.readonly), as the e2e login stands in for it.
  await page.goto(`/api/e2e/login?email=${encodeURIComponent(starterEmail)}&next=${encodeURIComponent(`/orgs/${companyId}`)}&kalender=1`);

  await page.goto(`/meetings/ny/${companyId}`);
  await expect(page.getByRole("heading", { name: "Innan ni börjar" })).toBeVisible();
  // Offered, never attached by itself.
  const link = page.getByRole("checkbox", { name: /Koppla till kalenderhändelsen ”Kundmöte Acme”/ });
  await expect(link).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Lisa Lind/ })).toHaveCount(0);
  await link.check();
  // The colleagues on the invite: the accepted one pre-ticked, the other not; the customer from the outside domain.
  await expect(page.getByRole("checkbox", { name: /Lisa Lind/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Per Persson/ })).not.toBeChecked();
  // Dan declined: shown as such and can't be ticked.
  await expect(page.getByRole("checkbox", { name: /Dan Dahl/ })).toBeDisabled();
  await expect(page.getByText("Tackade nej, räknas inte som deltagare")).toBeVisible();
  await expect(page.getByText("Kund: gästerna från acme.se")).toBeVisible();
  await expect(page.getByText(/Plus 1 deltagare du kryssat i/)).toBeVisible();
  await expectAccessible(page);
  await snap(page, "starta-mote-kalender");

  const consent = page.getByRole("checkbox", { name: "Alla i rummet vet att mötet transkriberas och kan be om paus" });
  await expect(async () => {
    await consent.check({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Starta mötet" }).click();
  await expect(page.getByRole("heading", { name: "Namnrunda" })).toBeVisible({ timeout: 30_000 });
  const meetingId = page.url().split("/").at(-1)!;

  // Only the starter and the ticked colleague attend; Per (on the invite, not ticked) doesn't.
  const attendees = must("attendees", await db.from("meeting_attendees").select("user_id, source").eq("meeting_id", meetingId)) as { user_id: string; source: string }[];
  expect(attendees.map((a) => `${a.user_id}:${a.source}`).sort()).toEqual([`${lisaId}:calendar`, `${starterId}:starter`].sort());
  const row = must("meeting", await db.from("meetings").select("context_id").eq("id", meetingId).single()) as { context_id: string | null };
  expect(row.context_id).not.toBeNull();
  const customer = must("customer", await db.from("contexts").select("domain").eq("id", row.context_id!).single()) as { domain: string };
  expect(customer.domain).toBe("acme.se");
  must("end", await db.from("meetings").update({ status: "done" }).eq("id", meetingId));
});
