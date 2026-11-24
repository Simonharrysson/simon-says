import type { docs_v1 } from "@googleapis/docs";
import type { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), batchUpdate: vi.fn() }));
vi.mock("@/lib/google/docs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/docs")>()),
  docsApi: () => ({ documents: { get: api.get, batchUpdate: api.batchUpdate } }),
}));

import { appendTranscript, formatLine, formatTimestamp } from "./transcript";

const auth = {} as OAuth2Client;
const TAB = "t.1";

/** A documents.get response whose tab holds `paragraphs` (each ends with the newline Docs adds). */
function doc(paragraphs: string[]): docs_v1.Schema$Document {
  let index = 1;
  const content: docs_v1.Schema$StructuralElement[] = [{ endIndex: 1, sectionBreak: {} }];
  for (const p of paragraphs) {
    const len = p.length + 1;
    content.push({
      startIndex: index,
      endIndex: index + len,
      paragraph: { elements: [{ startIndex: index, endIndex: index + len, textRun: { content: `${p}\n` } }] },
    });
    index += len;
  }
  return {
    revisionId: "r1",
    tabs: [{ tabProperties: { tabId: TAB, title: "Transkript" }, documentTab: { body: { content } } }],
  };
}

const lines = [
  { speaker: "Anna", atMs: (41 * 60 + 52) * 1000, text: "Vi tar det på torsdag." },
  { speaker: "Erik", atMs: (41 * 60 + 58) * 1000 + 400, text: "Passar bra." },
];

const sentText = () => {
  expect(api.batchUpdate).toHaveBeenCalledTimes(1);
  const body = api.batchUpdate.mock.calls[0][0];
  expect(body.requestBody.requests).toHaveLength(1);
  return body.requestBody.requests[0].insertText as { text: string; endOfSegmentLocation: { tabId: string } };
};

beforeEach(() => {
  api.get.mockReset();
  api.batchUpdate.mockReset().mockResolvedValue({ data: {} });
});

describe("formatTimestamp / formatLine", () => {
  it("formats HH:MM:SS, flooring milliseconds", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp((41 * 60 + 52) * 1000 + 999)).toBe("00:41:52");
    expect(formatTimestamp((3 * 3600 + 5 * 60 + 9) * 1000)).toBe("03:05:09");
    expect(formatLine(lines[0])).toBe("Anna 00:41:52: Vi tar det på torsdag.");
  });

  it("keeps one line per entry even if the text has newlines", () => {
    expect(formatLine({ speaker: "A", atMs: 0, text: "rad ett\nrad två" })).toBe("A 00:00:00: rad ett rad två");
  });
});

describe("appendTranscript", () => {
  it("sends one insertText at endOfSegmentLocation with the tabId and the formatted lines", async () => {
    api.get.mockResolvedValue({ data: doc([""]) });
    await appendTranscript(auth, "doc1", TAB, lines);
    expect(api.batchUpdate.mock.calls[0][0].documentId).toBe("doc1");
    const sent = sentText();
    expect(sent.endOfSegmentLocation).toEqual({ tabId: TAB });
    expect(sent.text).toBe("Anna 00:41:52: Vi tar det på torsdag.\nErik 00:41:58: Passar bra.\n");
  });

  it("reads the Doc with tab content", async () => {
    api.get.mockResolvedValue({ data: doc([""]) });
    await appendTranscript(auth, "doc1", TAB, lines);
    expect(api.get).toHaveBeenCalledWith({ documentId: "doc1", includeTabsContent: true });
  });

  it("prefixes a newline when the last paragraph is non-empty (a person is typing there)", async () => {
    api.get.mockResolvedValue({ data: doc(["Anna 00:00:01: hej", "jag skriver här"]) });
    await appendTranscript(auth, "doc1", TAB, lines);
    expect(sentText().text.startsWith("\nAnna 00:41:52")).toBe(true);
  });

  it("does not prefix when the last paragraph is empty", async () => {
    api.get.mockResolvedValue({ data: doc(["Anna 00:00:01: hej", ""]) });
    await appendTranscript(auth, "doc1", TAB, lines);
    expect(sentText().text.startsWith("Anna")).toBe(true);
  });

  it("does not prefix in a brand-new empty tab", async () => {
    api.get.mockResolvedValue({ data: doc([]) });
    await appendTranscript(auth, "doc1", TAB, lines);
    expect(sentText().text.startsWith("Anna")).toBe(true);
  });

  it("skips a batch already in the tab (append succeeded, marking it written did not)", async () => {
    api.get.mockResolvedValue({
      data: doc(["Anna 00:41:52: Vi tar det på torsdag.", "Erik 00:41:58: Passar bra.", "någon skriver"]),
    });
    await appendTranscript(auth, "doc1", TAB, lines);
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });

  it("still appends when only part of the batch is there", async () => {
    api.get.mockResolvedValue({ data: doc(["Anna 00:41:52: Vi tar det på torsdag.", ""]) });
    await appendTranscript(auth, "doc1", TAB, lines);
    expect(sentText().text).toContain("Erik 00:41:58: Passar bra.");
  });

  it("does nothing for no lines", async () => {
    await appendTranscript(auth, "doc1", TAB, []);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.batchUpdate).not.toHaveBeenCalled();
  });
});
