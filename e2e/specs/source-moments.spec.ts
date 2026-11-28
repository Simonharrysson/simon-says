import { randomUUID } from "node:crypto";
import { auditBorders, formatOffenders } from "../border-audit";
import { expect, expectAccessible, seedMeeting, test } from "../fixtures";

// Source moments (0068): a decision and a task on a finished meeting's page show "▶ mm:ss"; a click
// opens the transcript sheet (a side sheet, a bottom sheet on a phone) scrolled to that line,
// highlighted, with a few lines around it. Text only. Once the förening stops sharing its
// transcript, the links are gone. Fictional data.

const must = <T>(what: string, r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

test("▶ on a decision opens the transcript at that line, highlighted; hidden transcript: no link @phone", async ({ page, db, seedOrg }) => {
  const org = await seedOrg();
  const m = await seedMeeting(db, org, {
    items: [
      { section: "decision", text: "Höstfesten blir 14 november" },
      { section: "action", text: "Boka festlokalen", owner: "Anna Berg" },
      { section: "decision", text: "Ett beslut från förr" },
    ],
  });
  const session = `el-${randomUUID()}`;
  must("session", await db.from("el_sessions").insert({ id: session, meeting_id: m.id, max_seconds: 3600 }));
  must("speakers", await db.from("speaker_map").insert({ meeting_id: m.id, el_session_id: session, speaker_label: "speaker_0", display_name: "Anna Berg" }));
  const lines = ["Välkomna allihop", "Vi tar höstfesten först", "Förslag: 14 november", "Låter bra, vi kör på det", "Jag bokar festlokalen till fredag", "Nästa punkt"];
  must(
    "segments",
    await db.from("segments").insert(
      lines.map((text, i) => ({
        meeting_id: m.id,
        el_session_id: session,
        segment_index: i,
        run_index: 0,
        speaker: "speaker_0",
        text,
        // 40:52, 41:22, 41:52 …
        start_ms: (40 * 60 + 52 + 30 * i) * 1000,
        end_ms: (40 * 60 + 52 + 30 * i) * 1000 + 4000,
        tick_no: 1,
      })),
    ),
  );
  must("n1", await db.from("note_items").update({ source_segment_ids: [`${session}:3:0`], said_at_ms: (42 * 60 + 22) * 1000 }).eq("meeting_id", m.id).eq("id", "n1"));
  must("n2", await db.from("note_items").update({ source_segment_ids: [`${session}:4:0`], said_at_ms: (42 * 60 + 52) * 1000 }).eq("meeting_id", m.id).eq("id", "n2"));

  await page.goto(`/orgs/${org.id}/mote/${m.id}`);
  await expect(page.getByRole("heading", { name: "Beslut" })).toBeVisible();
  const decisionLink = page.getByRole("button", { name: "Visa var det sades i transkriptionen, 42:22" });
  await expect(decisionLink).toBeVisible();
  await expect(decisionLink).toHaveText("▶42:22");
  await expect(page.getByRole("button", { name: "Visa var det sades i transkriptionen, 42:52" })).toBeVisible();
  // An old decision without a source: no link, no error.
  await expect(page.getByRole("listitem").filter({ hasText: "Ett beslut från förr" }).getByRole("button")).toHaveCount(0);

  await decisionLink.click();
  const sheet = page.getByRole("dialog", { name: "Sagt vid 42:22" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Ingen ljudinspelning sparas");
  const highlighted = sheet.locator("[data-source]");
  await expect(highlighted).toHaveCount(1);
  await expect(highlighted).toContainText("Låter bra, vi kör på det");
  await expect(highlighted).toContainText("Anna Berg");
  await expect(highlighted).toBeInViewport();
  // A few lines of context around it.
  await expect(sheet).toContainText("Förslag: 14 november");
  await expect(sheet).toContainText("Jag bokar festlokalen till fredag");
  await expectAccessible(page);
  expect(formatOffenders("transcript sheet", await auditBorders(page)), "double borders (box in a box, or lines that touch)").toEqual([]);
  await sheet.getByRole("button", { name: "Stäng" }).click();
  await expect(sheet).toBeHidden();
  await expect(decisionLink).toBeFocused();

  // The task's link opens its own moment.
  await page.getByRole("button", { name: "Visa var det sades i transkriptionen, 42:52" }).click();
  await expect(page.getByRole("dialog", { name: "Sagt vid 42:52" }).locator("[data-source]")).toContainText("Jag bokar festlokalen till fredag");
  await page.keyboard.press("Escape");

  // Dark: the highlighted line still reads (axe contrast), and a second open is instant (cached) and scrolled.
  await page.emulateMedia({ colorScheme: "dark" });
  await decisionLink.click();
  const dark = page.getByRole("dialog", { name: "Sagt vid 42:22" });
  await expect(dark.locator("[data-source]")).toBeInViewport();
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(dark).toBeHidden();
  await page.emulateMedia({ colorScheme: "light" });

  // The förening stops sharing its transcript: no links at all.
  must("share off", await db.from("orgs").update({ share_transcript: false }).eq("id", org.id));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Beslut" })).toBeVisible();
  await expect(page.getByText("Höstfesten blir 14 november")).toBeVisible();
  await expect(page.getByRole("button", { name: /Visa var det sades/ })).toHaveCount(0);
});
