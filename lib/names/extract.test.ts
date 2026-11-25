import { describe, expect, it } from "vitest";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { extractNames, matchKnown, NameRoundError, type NameSegment } from "./extract";

const seg = (speaker: string, text: string, start_ms = 0, el_session_id = "sess-a"): NameSegment => ({
  el_session_id,
  speaker,
  text,
  start_ms,
});

function fakeClient(
  speakers: { speaker: string; name: string; needs_confirm: boolean }[],
  over: Partial<BetaMessage> = {},
) {
  const bodies: BetaMessageStreamParams[] = [];
  const client = {
    beta: {
      messages: {
        stream(body: BetaMessageStreamParams) {
          bodies.push(body);
          return {
            finalMessage: async () =>
              ({
                id: "msg",
                type: "message",
                role: "assistant",
                model: "claude-opus-5-5",
                stop_reason: "end_turn",
                content: [{ type: "text", text: JSON.stringify({ speakers }) }],
                usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                ...over,
              }) as unknown as BetaMessage,
          };
        },
      },
    },
  };
  return { client, bodies };
}

describe("matchKnown", () => {
  it("prefers the known spelling: exact, first name, one letter off", () => {
    expect(matchKnown("eric", ["Eric", "Anna"])).toBe("Eric");
    expect(matchKnown("Erik", ["Eric", "Anna"])).toBe("Eric");
    expect(matchKnown("Karin", ["Karin Ek", "Jonas Holm"])).toBe("Karin Ek");
    expect(matchKnown("Leila Naser", ["Leila Nasser"])).toBe("Leila Nasser");
  });
  it("keeps the heard name when nothing or more than one candidate matches", () => {
    expect(matchKnown("Per", ["Eric"])).toBe("Per");
    expect(matchKnown("Anne", ["Anna", "Anni"])).toBe("Anne");
    expect(matchKnown("Karin", ["Karin Ek", "Karin Berg"])).toBe("Karin");
    expect(matchKnown("Bo", ["Bob"])).toBe("Bo"); // too short for a fuzzy match
  });
});

describe("extractNames", () => {
  it("'Jag heter Erik' + known 'Eric' → 'Eric'", async () => {
    const { client, bodies } = fakeClient([{ speaker: "S1-speaker_0", name: "Erik", needs_confirm: false }]);
    const out = await extractNames([seg("speaker_0", "Hej, jag heter Erik.")], ["Eric"], { client });
    expect(out).toEqual([{ elSessionId: "sess-a", speakerLabel: "speaker_0", name: "Eric", needsConfirm: false }]);
    // Same settings as the notes engine.
    const body = bodies[0] as BetaMessageStreamParams & { fallbacks?: string };
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config).toMatchObject({ effort: "medium", format: { type: "json_schema" } });
    expect(body.fallbacks).toBe("default");
    const text = JSON.stringify(body.messages);
    expect(text).toContain("S1-speaker_0: Hej, jag heter Erik.");
    expect(text).toContain("Eric");
  });

  it("two labels claiming the same name → both need confirming", async () => {
    const { client } = fakeClient([
      { speaker: "S1-speaker_0", name: "Anna", needs_confirm: false },
      { speaker: "S1-speaker_1", name: "anna", needs_confirm: false },
      { speaker: "S1-speaker_2", name: "Per", needs_confirm: false },
    ]);
    const out = await extractNames(
      [seg("speaker_0", "Jag heter Anna"), seg("speaker_1", "Anna här", 1000), seg("speaker_2", "Per", 2000)],
      [],
      { client },
    );
    expect(out.map((n) => [n.speakerLabel, n.name, n.needsConfirm])).toEqual([
      ["speaker_0", "Anna", true],
      ["speaker_1", "anna", true],
      ["speaker_2", "Per", false],
    ]);
  });

  it("drops labels that were not in the transcript, empty names and repeats; keeps sessions apart", async () => {
    const { client } = fakeClient([
      { speaker: "S1-speaker_0", name: "  Karin   Ek ", needs_confirm: false },
      { speaker: "S1-speaker_0", name: "Someone", needs_confirm: false },
      { speaker: "S1-speaker_9", name: "Ghost", needs_confirm: false },
      { speaker: "S2-speaker_0", name: "Jonas", needs_confirm: true },
      { speaker: "S2-speaker_1", name: " ", needs_confirm: false },
    ]);
    const out = await extractNames(
      [seg("speaker_0", "Karin Ek"), seg("speaker_0", "Jonas", 5000, "sess-b"), seg("speaker_1", "ja", 6000, "sess-b")],
      [],
      { client },
    );
    expect(out).toEqual([
      { elSessionId: "sess-a", speakerLabel: "speaker_0", name: "Karin Ek", needsConfirm: false },
      { elSessionId: "sess-b", speakerLabel: "speaker_0", name: "Jonas", needsConfirm: true },
    ]);
  });

  it("reports usage, and throws on a refusal, a cut-off answer, bad JSON or a failed request", async () => {
    const usage: number[] = [];
    const ok = fakeClient([]);
    expect(await extractNames([seg("speaker_0", "hej")], [], { client: ok.client, onUsage: (u) => usage.push(u.input) })).toEqual([]);
    expect(usage).toEqual([1000]);

    for (const over of [{ stop_reason: "refusal" }, { stop_reason: "max_tokens" }, { content: [{ type: "text", text: "nope" }] }]) {
      const bad = fakeClient([], over as Partial<BetaMessage>);
      const seen: number[] = [];
      await expect(
        extractNames([seg("speaker_0", "hej")], [], { client: bad.client, onUsage: (u) => seen.push(u.input) }),
      ).rejects.toBeInstanceOf(NameRoundError);
      expect(seen).toEqual([1000]); // spent tokens count even when the answer is unusable
    }

    const failing = {
      beta: { messages: { stream: () => ({ finalMessage: async () => Promise.reject(new Error("timeout")) }) } },
    };
    await expect(extractNames([seg("speaker_0", "hej")], [], { client: failing })).rejects.toBeInstanceOf(NameRoundError);
  });

  it("no segments: no call", async () => {
    const { client, bodies } = fakeClient([]);
    expect(await extractNames([], ["Eric"], { client })).toEqual([]);
    expect(bodies).toHaveLength(0);
  });
});
