/**
 * Task 11 early check: the name round against the real Claude API, on the Testmöte fixture's
 * first two minutes (and optionally a known-people list).
 *
 *   npm run check-names [-- --known "Karin Ek,Jonas Holm"] [--ms 120000]
 *
 * Prints the names per label, the expected names (fixture oracle), latency, tokens and cost.
 * Reads ANTHROPIC_API_KEY from the environment or ~/simon-says-private/.env. Never prints it.
 */
import Anthropic from "@anthropic-ai/sdk";
import expected from "@/fixtures/notes/synthetic.expected.json";
import { extractNames, EXTRACT_TIMEOUT_MS } from "@/lib/names/extract";
import type { NotesClient, NotesUsage } from "@/lib/notes/engine";
import { FIXTURE_LINES, toSegments } from "@/lib/testmeeting/fixture";
import { apiKey } from "./lib/notes-run";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const windowMs = Number(arg("ms") ?? 120_000);
  const known = (arg("known") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const segments = toSegments(FIXTURE_LINES, "test-session")
    .filter((s) => s.startMs <= windowMs)
    .map((s) => ({ el_session_id: s.elSessionId, speaker: s.speaker, text: s.text, start_ms: s.startMs }));
  const client = new Anthropic({ apiKey: apiKey(), timeout: EXTRACT_TIMEOUT_MS, maxRetries: 0 }) as unknown as NotesClient;
  let usage: NotesUsage | null = null;
  const t0 = Date.now();
  const names = await extractNames(segments, known, { client, onUsage: (u) => void (usage = u) });
  const ms = Date.now() - t0;
  const oracle = expected.speakerNames as Record<string, string>;
  let hits = 0;
  for (const [label, want] of Object.entries(oracle)) {
    const got = names.find((n) => `S1-${n.speakerLabel}` === label);
    if (got?.name === want) hits++;
    console.log(`${label}: ${got ? `${got.name}${got.needsConfirm ? "?" : ""}` : "—"} (expected ${want})`);
  }
  const u = usage as NotesUsage | null;
  console.log(`${segments.length} lines, ${hits}/${Object.keys(oracle).length} right, ${ms} ms, in ${u?.input} out ${u?.output} tokens, $${u?.usd.toFixed(4)}`);
  if (hits !== Object.keys(oracle).length) process.exitCode = 1;
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
