import { describe, expect, it, vi } from "vitest";

const oneShotMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notes/oneshot", () => ({ oneShot: oneShotMock }));

const { buildPrivatSummaryUserText, cleanAnswer, fitTranscript, PRIVAT_SUMMARY_JSON_SCHEMA, PRIVAT_SUMMARY_SYSTEM_PROMPT, summarizePrivat } = await import("./summary");

const input = {
  locale: "sv" as const,
  contextName: "TDDE15",
  userName: "Simon Harrysson",
  startedAt: "2026-11-26T09:00:00Z",
  notes: ["Beslut: Labb 2 lämnas in på fredag"],
  transcript: ["[00:00:05] Simon: Vi kör labb 2 nu", "[00:01:10] Anna: Jag fixar rapporten"],
  openTasks: [{ key: "t1", text: "Boka grupprum", owner: null, since: "2026-11-19T09:00:00Z" }],
  recentDecisions: ["Vi skriver i LaTeX"],
};

describe("Privat summary prompt", () => {
  it("gives Claude the context, the open tasks by id, earlier decisions, notes and transcript", () => {
    const text = buildPrivatSummaryUserText(input);
    expect(text).toContain("Swedish");
    expect(text).toContain("Context: TDDE15");
    expect(text).toContain("[t1] Boka grupprum (since 2026-11-19)");
    expect(text).toContain("- Vi skriver i LaTeX");
    expect(text).toContain("Beslut: Labb 2 lämnas in på fredag");
    expect(text).toContain("[00:01:10] Anna: Jag fixar rapporten");
    expect(buildPrivatSummaryUserText({ ...input, locale: "en", openTasks: [] })).toMatch(/English[\s\S]*<open_tasks>\n\(none\)/);
  });

  it("keeps the end of a transcript that is too long", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `rad ${i}`);
    const fit = fitTranscript(lines, 20);
    expect(fit.cut).toBe(true);
    expect(fit.lines.at(-1)).toBe("rad 9");
    expect(fit.lines.join("\n").length).toBeLessThanOrEqual(20);
    expect(fitTranscript(lines).cut).toBe(false);
  });

  it("the JSON schema requires every field (structured output)", () => {
    expect(PRIVAT_SUMMARY_JSON_SCHEMA.required).toEqual(["summary", "decisions", "facts", "tasks", "questions", "people", "topics", "previous"]);
  });

  it("cleans the answer: one line each, no empties or duplicates", () => {
    const a = cleanAnswer({
      summary: " Vi gick\nigenom labb 2. ",
      decisions: ["Fredag", "Fredag", " "],
      facts: [],
      tasks: [
        { text: " Skriv rapporten ", owner: " ", due: "fredag" },
        { text: "", owner: null, due: null },
      ],
      questions: [],
      people: ["Anna"],
      topics: ["labb 2"],
      previous: [{ id: "t1", status: "done" }],
    });
    expect(a.summary).toBe("Vi gick igenom labb 2.");
    expect(a.decisions).toEqual(["Fredag"]);
    expect(a.tasks).toEqual([{ text: "Skriv rapporten", owner: null, due: "fredag" }]);
  });

  it("one call through oneShot (spend gate on), usage on the space, the answer cleaned", async () => {
    const value = { summary: " Kort. ", decisions: ["A", "A"], facts: [], tasks: [], questions: [], people: [], topics: [], previous: [{ id: "t1", status: "open" as const }] };
    oneShotMock.mockResolvedValueOnce({ ok: true, value, usage: null });
    const res = await summarizePrivat()(input, { orgId: "space-1", timeoutMs: 30_000 });
    expect(oneShotMock).toHaveBeenCalledTimes(1);
    const call = oneShotMock.mock.calls[0][0];
    expect(call.system).toBe(PRIVAT_SUMMARY_SYSTEM_PROMPT);
    expect(call.orgId).toBe("space-1");
    expect(call.checkSpend).toBeUndefined(); // default: KILL_SWITCH and the daily cap are checked
    expect(call.jsonSchema).toBe(PRIVAT_SUMMARY_JSON_SCHEMA);
    expect(res.ok && res.value).toMatchObject({ summary: "Kort.", decisions: ["A"] });
    oneShotMock.mockResolvedValueOnce({ ok: false, reason: "spend", detail: "cap", usage: null });
    expect(await summarizePrivat()(input, { orgId: "space-1" })).toMatchObject({ ok: false, reason: "spend" });
  });
});
