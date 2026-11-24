import { describe, expect, it, vi } from "vitest";
import {
  appendToTab,
  isRevisionConflict,
  paragraphsWithRanges,
  readTab,
  replaceRange,
  writeWithRevisionGuard,
} from "./docs";

const conflict = () =>
  Object.assign(new Error("The required revision ID 'x' does not match the latest revision."), { status: 400 });

describe("paragraphsWithRanges", () => {
  it("inserts the joined text and one range per item, in UTF-16 indices, all with the tabId", () => {
    const reqs = paragraphsWithRanges("t.0", 1, [
      { name: "a", text: "två" },
      { name: "b", text: "😀x" },
      { name: "c", text: "end" },
    ]);
    expect(reqs[0]).toEqual({ insertText: { text: "två\n😀x\nend", location: { index: 1, tabId: "t.0" } } });
    expect(reqs.slice(1).map((r) => r.createNamedRange?.range)).toEqual([
      { tabId: "t.0", startIndex: 1, endIndex: 4 },
      { tabId: "t.0", startIndex: 5, endIndex: 8 },
      { tabId: "t.0", startIndex: 9, endIndex: 12 },
    ]);
  });

  it("rejects an item with a newline", () => {
    expect(() => paragraphsWithRanges("t.0", 1, [{ name: "a", text: "x\ny" }])).toThrow(/newline/);
  });
});

describe("request builders", () => {
  it("replaceRange is scoped with tabsCriteria", () => {
    expect(replaceRange("t.0", "a", "new")).toEqual({
      replaceNamedRangeContent: { namedRangeName: "a", text: "new", tabsCriteria: { tabIds: ["t.0"] } },
    });
  });

  it("appendToTab uses endOfSegmentLocation with the tabId", () => {
    expect(appendToTab("t.1", "hej\n")).toEqual({
      insertText: { text: "hej\n", endOfSegmentLocation: { tabId: "t.1" } },
    });
  });
});

describe("readTab", () => {
  const doc = {
    revisionId: "rev1",
    tabs: [
      { tabProperties: { tabId: "t.0", title: "Anteckningar" }, documentTab: { body: { content: [] } } },
      {
        tabProperties: { tabId: "t.1", title: "Transkript" },
        documentTab: {
          body: {
            content: [
              { sectionBreak: {}, endIndex: 1 },
              { paragraph: { elements: [{ startIndex: 1, textRun: { content: "ab\n" } }] } },
              {
                paragraph: {
                  elements: [
                    { startIndex: 4, textRun: { content: "c" } },
                    { startIndex: 5, textRun: { content: "d\n" } },
                  ],
                },
              },
            ],
          },
          namedRanges: {
            r: {
              name: "r",
              namedRanges: [
                {
                  name: "r",
                  namedRangeId: "kix.1",
                  ranges: [
                    { startIndex: 1, endIndex: 3, tabId: "t.1" },
                    { startIndex: 4, endIndex: 6, tabId: "t.1" },
                  ],
                },
              ],
            },
          },
        },
      },
    ],
  };

  it("returns the tab text and named ranges with their parts' text", () => {
    const snap = readTab(doc, "t.1");
    expect(snap).toMatchObject({ revisionId: "rev1", title: "Transkript", text: "ab\ncd\n", startIndex: 1 });
    expect(snap.ranges).toEqual([
      {
        name: "r",
        namedRangeId: "kix.1",
        parts: [
          { startIndex: 1, endIndex: 3, text: "ab" },
          { startIndex: 4, endIndex: 6, text: "cd" },
        ],
      },
    ]);
  });

  it("throws for an unknown tab", () => {
    expect(() => readTab(doc, "t.9")).toThrow(/not found/);
  });
});

describe("isRevisionConflict", () => {
  it("is true for a 400 about the revision", () => {
    expect(isRevisionConflict(conflict())).toBe(true);
  });
  it("is false for other 400s and other statuses", () => {
    expect(isRevisionConflict(Object.assign(new Error("Invalid requests[0]"), { status: 400 }))).toBe(false);
    expect(isRevisionConflict(Object.assign(new Error("revision"), { status: 500 }))).toBe(false);
  });
});

describe("writeWithRevisionGuard", () => {
  it("re-reads and retries after a conflict", async () => {
    const read = vi.fn(async () => "snap");
    const write = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce("ok");
    await expect(writeWithRevisionGuard(read, write)).resolves.toEqual({ value: "ok", conflicts: 1 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("gives up after 4 retries (5 attempts)", async () => {
    const write = vi.fn().mockRejectedValue(conflict());
    await expect(writeWithRevisionGuard(async () => 0, write)).rejects.toThrow(/revision/);
    expect(write).toHaveBeenCalledTimes(5);
  });

  it("does not retry other errors", async () => {
    const write = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(writeWithRevisionGuard(async () => 0, write)).rejects.toThrow("boom");
    expect(write).toHaveBeenCalledTimes(1);
  });
});
