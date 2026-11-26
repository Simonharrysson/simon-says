import Anthropic from "@anthropic-ai/sdk";
import { OAuth2Client } from "google-auth-library";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMeetingDoc } from "@/lib/docs/create";
import { appendTranscript } from "@/lib/docs/transcript";
import { docsApi, driveApi, readTab } from "@/lib/google/docs";
import { SYSTEM_PROMPT } from "@/lib/notes/prompt";
import { SCRIPTED } from "./claude";
import { startFakes } from "./server";

// The e2e fakes driven by the real lib code, so a fake that drifts from what the app sends fails
// here (fast, no browser, no database) and not halfway through a Playwright run.

const PORT = 4710;
let fakes: Awaited<ReturnType<typeof startFakes>>;
const saved = { ...process.env };

beforeAll(async () => {
  fakes = await startFakes(PORT, { quiet: true });
  Object.assign(process.env, {
    E2E_TEST_MODE: "1",
    SUPABASE_URL: "http://127.0.0.1:54321",
    E2E_GOOGLE_ROOT: `http://127.0.0.1:${PORT}/`,
  });
});
afterAll(async () => {
  await fakes.close();
  process.env = saved;
});

const auth = (email = "anna@e2e.test") => {
  const c = new OAuth2Client({ clientId: "e2e", clientSecret: "e2e", endpoints: { oauth2TokenUrl: `http://127.0.0.1:${PORT}/token` } });
  c.setCredentials({ refresh_token: `e2e-refresh:${email}` });
  return c;
};

describe("fake Google", () => {
  it("refreshes the e2e token and refuses any other", async () => {
    const token = await auth().getAccessToken();
    expect(token.token).toBe("e2e-at:anna@e2e.test");
    const bad = new OAuth2Client({ endpoints: { oauth2TokenUrl: `http://127.0.0.1:${PORT}/token` } });
    bad.setCredentials({ refresh_token: "real-token" });
    await expect(bad.getAccessToken()).rejects.toThrow(/invalid_grant/);
  });

  it("runs createMeetingDoc and appendTranscript like Google", async () => {
    const a = auth();
    const doc = await createMeetingDoc(a, {
      meetingId: "m1",
      orgName: "Testföreningen",
      startedAt: new Date("2026-11-26T17:00:00Z"),
      title: "2026-11-26 18.00 Mötesprotokoll – Testföreningen",
      memberEmails: ["erik@e2e.test"],
      shareTranscript: true,
    });
    expect(doc.place).toBe("own_folder");
    expect(doc.shared).toEqual(["erik@e2e.test"]);
    expect(doc.transcriptTabId).toBeTruthy();

    await appendTranscript(a, doc.docId, doc.transcriptTabId!, [{ at: new Date("2026-11-26T17:01:00Z"), speaker: "Anna", text: "Hej allihop." }] as never);
    const view = fakes.google.docView(doc.docId)!;
    expect(view.tabs.map((t) => t.title)).toEqual(["Anteckningar", "Transkript"]);
    expect(view.tabs[0].text).toContain("LIVE · uppdaterad –\nNärvarande\nBeslut\nAtt göra\nPågår nu");
    expect(view.tabs[1].text).toContain("Hej allihop.");

    // The named ranges are where the notes code expects them.
    const got = (await docsApi(a).documents.get({ documentId: doc.docId, includeTabsContent: true })).data;
    const tab = readTab(got, doc.notesTabId);
    expect(tab.ranges.map((r) => r.parts[0].text)).toEqual(["LIVE · uppdaterad –", "Närvarande", "Beslut", "Att göra", "Pågår nu"]);

    // The folder is found again, not created twice.
    const folders = await driveApi(a).files.list({ q: "mimeType='application/vnd.google-apps.folder' and name='Simon Says – Testföreningen' and trashed=false and 'me' in owners" });
    expect(folders.data.files).toHaveLength(1);
  });

  it("refuses a write against an old revision with a revision error", async () => {
    const a = auth();
    const file = fakes.google.createFile({ name: "Dagordning", paragraphs: [{ text: "Punkt ett" }] });
    const before = (await docsApi(a).documents.get({ documentId: file.id, includeTabsContent: true })).data.revisionId!;
    await docsApi(a).documents.batchUpdate({ documentId: file.id, requestBody: { requests: [{ insertText: { text: "A", location: { tabId: "t.0", index: 1 } } }] } });
    await expect(
      docsApi(a).documents.batchUpdate({
        documentId: file.id,
        requestBody: { requests: [{ insertText: { text: "B", location: { tabId: "t.0", index: 1 } } }], writeControl: { requiredRevisionId: before } },
      }),
    ).rejects.toThrow(/revision/);
    expect(fakes.google.docView(file.id)!.tabs[0].text).toBe("APunkt ett\n");
  });

  it("replaces a named range's content and keeps the range", async () => {
    const a = auth();
    const file = fakes.google.createFile({ name: "Doc" });
    const requests = [
      { insertText: { text: "LIVE · uppdaterad –", location: { tabId: "t.0", index: 1 } } },
      { createNamedRange: { name: "h", range: { tabId: "t.0", startIndex: 1, endIndex: 20 } } },
    ];
    await docsApi(a).documents.batchUpdate({ documentId: file.id, requestBody: { requests } });
    for (const text of ["LIVE · uppdaterad 18:01", "Avslutat 19:10"]) {
      await docsApi(a).documents.batchUpdate({
        documentId: file.id,
        requestBody: { requests: [{ replaceNamedRangeContent: { namedRangeName: "h", text, tabsCriteria: { tabIds: ["t.0"] } } }] },
      });
    }
    const got = (await docsApi(a).documents.get({ documentId: file.id, includeTabsContent: true })).data;
    expect(readTab(got, "t.0").ranges[0].parts[0].text).toBe("Avslutat 19:10");
  });
});

describe("fake Claude", () => {
  it("streams the scripted notes ops to the SDK", async () => {
    const client = new Anthropic({ apiKey: "e2e", baseURL: `http://127.0.0.1:${PORT}/anthropic` });
    const msg = await client.beta.messages
      .stream({ model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: SYSTEM_PROMPT }], messages: [{ role: "user", content: "transkript" }] })
      .finalMessage();
    const block = msg.content[0];
    expect(block.type).toBe("text");
    const ops = JSON.parse((block as { text: string }).text).ops as { text: string }[];
    expect(ops.map((o) => o.text)).toContain(SCRIPTED.decision);
    expect(fakes.claude.calls.at(-1)?.kind).toBe("notes");
  });

  it("fails an unscripted call loudly", async () => {
    const client = new Anthropic({ apiKey: "e2e", baseURL: `http://127.0.0.1:${PORT}/anthropic`, maxRetries: 0 });
    await expect(client.messages.create({ model: "x", max_tokens: 10, system: "Something new", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();
    expect(fakes.claude.problems.at(-1)?.what).toMatch(/unscripted/);
  });
});
