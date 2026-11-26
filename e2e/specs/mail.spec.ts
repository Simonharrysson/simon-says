import { ADMIN_EMAIL } from "../env";
import { expect, expectAccessible, fake, guardContext, test } from "../fixtures";

// E-mail (0038, 0039): invites by e-mail through the fake mail provider, per-address results,
// an opted-out address, the /mejl unsubscribe page from the mail's own link, and the account's
// e-mail preferences. No real provider is ever called (E2E_MAIL_URL, lib/e2e/guard.ts).

test("Bjud in via mejl: rendered invite, per-address results, opted-out address; /mejl turns invites off @phone", async ({ page, browser, blocked, seedOrg, newEmail, db }) => {
  const org = await seedOrg();
  const ok = newEmail("inbjuden");
  const bounce = newEmail("studs").replace("@", "+fail@");
  const optedOut = newEmail("nej-tack");
  await db.from("email_address_preferences").insert({ email: optedOut, all_off: true });

  await page.goto(org.url);
  const invite = page.locator("section", { has: page.getByRole("heading", { name: "Bjud in via mejl" }) });
  await invite.getByLabel("E-postadresser").fill(`${ok}\nErik Lund <${bounce}>, ${optedOut}\ninte-en-adress`);
  await expect(invite.getByText("inte e-post: inte-en-adress")).toBeVisible();

  // The preview shows the mail as it goes out.
  await invite.getByRole("button", { name: "Visa mejlet" }).click();
  const preview = invite.getByRole("figure", { name: "Förhandsvisning av mejlet" });
  await expect(preview).toContainText(`bjuder in dig till ${org.name}`);
  await expectAccessible(page);

  await invite.getByRole("button", { name: "Skicka 3 inbjudningar" }).click();
  const results = invite.getByRole("list", { name: "Resultat" });
  const row = (email: string) => results.getByRole("listitem").filter({ hasText: email });
  await expect(row(ok)).toContainText("Skickat");
  await expect(row(bounce)).toContainText("Misslyckades");
  await expect(row(optedOut)).toContainText("Vill inte ha mejl");
  await expect(row("inte-en-adress")).toContainText("Ogiltig adress");

  // What the provider got: one invite to the address that works, nothing to the opted-out one.
  const [mail] = await fake.mail(ok);
  expect(mail.subject).toContain(`bjuder in dig till ${org.name}`);
  expect(mail.text).toContain(`/join/${org.inviteCode}`);
  expect(mail.reply_to).toBe(ADMIN_EMAIL);
  expect(mail.headers?.["List-Unsubscribe"]).toBeTruthy();
  expect(await fake.mail(optedOut)).toEqual([]);

  // The mail's own preferences link, opened by the recipient (not signed in).
  const prefsUrl = mail.text.match(/http:\/\/127\.0\.0\.1:\d+\/mejl\?\S+/)?.[0];
  expect(prefsUrl, "a /mejl link in the invite").toBeTruthy();
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await guardContext(context, blocked, {});
  const guest = await context.newPage();
  await guest.goto(prefsUrl!);
  await expect(guest.getByRole("heading", { name: "Mejl från Simon Says" })).toBeVisible();
  await expectAccessible(guest);
  const invites = guest.getByRole("switch", { name: /^Inbjudningar/ });
  await expect(invites).toBeChecked();
  await invites.click();
  await expect(guest.getByText("Sparat")).toBeVisible();
  const { data } = await db.from("email_address_preferences").select("off_categories, all_off").eq("email", ok).single();
  expect(data?.off_categories).toContain("invite");
  await guest.reload();
  await expect(guest.getByRole("switch", { name: /^Inbjudningar/ })).not.toBeChecked();
  await context.close();

  // A link that was tampered with is refused.
  const bad = new URL(prefsUrl!);
  bad.searchParams.set("t", `${bad.searchParams.get("t")}x`);
  await page.goto(bad.toString());
  await expect(page.getByRole("heading", { name: "Länken fungerar inte" })).toBeVisible();
});

test("Konto: e-mail preferences are saved for the account", async ({ seedOrg, signedIn, newEmail, db }) => {
  const email = newEmail("konto");
  await seedOrg({ admin: email });
  const { page } = await signedIn(email, "/installningar");
  const summaries = page.getByRole("switch", { name: /^Sammanfattning efter möten/ });
  await expect(summaries).toBeChecked();
  await expectAccessible(page);
  await summaries.click();
  await expect(page.getByText("Sparat")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: /^Sammanfattning efter möten/ })).not.toBeChecked();

  // "Inga mejl alls" turns everything off and locks the rows above.
  await page.getByRole("switch", { name: /^Inga mejl alls/ }).click();
  await expect(page.getByText("Sparat")).toBeVisible();
  await expect(page.getByRole("switch", { name: /^Inbjudningar/ })).toBeDisabled();
  const { data: user } = await db.auth.admin.listUsers({ perPage: 1000 });
  const id = user.users.find((u) => u.email === email)!.id;
  const { data } = await db.from("email_preferences").select("all_off, off_categories").eq("user_id", id).single();
  expect(data).toEqual({ all_off: true, off_categories: ["meeting_summary"] });
});
