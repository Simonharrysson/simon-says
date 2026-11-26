import { expect, expectAccessible, test } from "../fixtures";

// Om oss (todo #13): the admin writes the förening's short text and links in Inställningar; a
// member sees them in the förening page's header. The links are only checked, never followed
// (the fixture blocks any request to the real internet).

test("Om oss: the admin adds text and links, a member sees them @phone", async ({ page, seedOrg, newEmail, signedIn, db }) => {
  const member = newEmail("medlem");
  const org = await seedOrg({ members: [member] });
  await page.goto(`${org.url}?flik=installningar`);
  const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
  await expect(header.getByRole("list", { name: "Föreningen på nätet" })).toHaveCount(0);

  const settings = page.locator("section", { has: page.getByRole("heading", { name: "Allmänt" }) });
  const form = settings.locator("form", { has: page.getByRole("button", { name: "Spara Om oss" }) });
  await form.getByLabel("Om oss").fill("Vi spelar golf varje tisdag.\nAlla är välkomna.");
  await form.getByLabel("Webbplats").fill("exempel.se");
  await form.getByLabel("Facebook").fill("https://www.facebook.com/exempel");
  // A wrong host is refused with a sentence under the field; nothing is saved.
  await form.getByLabel("Instagram").fill("https://evil.example/exempel");
  await form.getByRole("button", { name: "Spara Om oss" }).click();
  await expect(form.getByText("Skriv ert Instagram-namn")).toBeVisible();
  await expectAccessible(page);

  await form.getByLabel("Instagram").fill("@exempel");
  await form.getByRole("button", { name: "Spara Om oss" }).click();
  await expect(form.getByText("Sparat")).toBeVisible();
  // The stored, canonical form comes back into the fields.
  await expect(form.getByLabel("Webbplats")).toHaveValue("https://exempel.se/");
  await expect(form.getByLabel("Facebook")).toHaveValue("https://facebook.com/exempel");
  await expect(form.getByLabel("Instagram")).toHaveValue("@exempel");

  const { data } = await db.from("orgs").select("about, website_url, facebook_url, instagram_url").eq("id", org.id).single();
  expect(data).toEqual({
    about: "Vi spelar golf varje tisdag.\nAlla är välkomna.",
    website_url: "https://exempel.se/",
    facebook_url: "https://facebook.com/exempel",
    instagram_url: "https://instagram.com/exempel",
  });

  // A member sees the text and the links in the header.
  const other = await signedIn(member, org.url);
  const otherHeader = other.page.locator("header").filter({ has: other.page.getByRole("heading", { level: 1 }) });
  await expect(other.page.getByText("Du är medlem")).toBeVisible();
  await expect(otherHeader.getByText("Vi spelar golf varje tisdag.")).toBeVisible();
  const links = otherHeader.getByRole("list", { name: "Föreningen på nätet" });
  for (const [name, href] of [
    [/Webbplats: exempel\.se/, "https://exempel.se/"],
    [/Facebook/, "https://facebook.com/exempel"],
    [/Instagram/, "https://instagram.com/exempel"],
  ] as const) {
    const link = links.getByRole("link", { name });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  // Members get no settings.
  await expect(other.page.getByRole("button", { name: "Spara Om oss" })).toHaveCount(0);
  await expectAccessible(other.page);
});
