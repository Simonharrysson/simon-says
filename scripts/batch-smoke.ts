/**
 * Paid smoke run of the import's batch path (lib/history/batch.ts): sends TWO short fictional
 * protocols in one real Anthropic Message Batch with the exact request the import builds, polls
 * until it ends, and reads the results the way the import cron does (stop_reason, structured
 * output, name scrubbing, 50 % pricing). Nothing touches the database.
 *
 *   npx tsx --conditions=react-server scripts/batch-smoke.ts [--budget 0.5] [--ledger file]
 *
 * Refuses to submit when the ledger (default .notes-replay/spend-batch.json) plus the worst case
 * of the two requests would pass --budget (USD). Reads ANTHROPIC_API_KEY from the environment or
 * ~/simon-says-private/.env; never prints it.
 */
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { PRICES } from "@/lib/notes/engine";
import { buildBatchRequest, itemIdOf, readBatchResult, type BatchClient } from "@/lib/history/batch";
import { apiKey, ledgerAdd, ledgerTotal } from "./lib/notes-run";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const LEDGER = arg("ledger") ?? join(".notes-replay", "spend-batch.json");
const budget = Number(arg("budget") ?? 0.5);

const PROTOCOLS = [
  {
    title: "Styrelsemöte Brädspelsföreningen Rutan 2025-09-02",
    text: [
      "Protokoll styrelsemöte 2025-09-02",
      "Närvarande: Ture Lindqvist (ordförande), Hedvig Sandberg (kassör), Malte Ek (sekreterare)",
      "§1 Mötets öppnande",
      "§2 Höstturneringen",
      "Beslut: Föreningen arrangerar en höstturnering i Catan den 18 oktober.",
      "Kassören bokar aulan till turneringen. (ej klart)",
      "§3 Medlemsvärvning",
      "Vi är nu 41 medlemmar, målet är 60 till jul.",
      "§4 Övrigt",
    ].join("\n"),
  },
  {
    title: "Protokoll 4/11-25",
    text: [
      "Styrelsemöte 4 november 2025",
      "§1 Mötets öppnande",
      "§2 Höstturneringen",
      "Turneringen genomfördes med 24 deltagare. Klart!",
      "§3 Medlemsvärvning",
      "52 medlemmar. Sekreteraren gör en affisch till vårterminen.",
      "Beslut: Medlemsavgiften höjs till 100 kr från januari.",
    ].join("\n"),
  },
];

async function main() {
  const worst = PROTOCOLS.length * ((4000 * PRICES.input + 16_000 * PRICES.output) / 1e6) * 0.5;
  const spent = ledgerTotal(LEDGER);
  if (spent + worst > budget) throw new Error(`budget: ledger $${spent.toFixed(4)} + worst case $${worst.toFixed(4)} > $${budget}`);
  const client = new Anthropic({ apiKey: apiKey() }) as unknown as BatchClient;
  const requests = PROTOCOLS.map((p, i) => buildBatchRequest(i + 1, p));
  const t0 = Date.now();
  const batch = await client.messages.batches.create({ requests });
  console.log(`submitted ${batch.id} (${requests.length} requests), worst case $${worst.toFixed(4)}, ledger $${spent.toFixed(4)}`);
  let b = batch;
  while (b.processing_status !== "ended") {
    await new Promise((r) => setTimeout(r, 20_000));
    b = await client.messages.batches.retrieve(batch.id);
    const c = b.request_counts;
    console.log(`  ${Math.round((Date.now() - t0) / 1000)} s: ${b.processing_status} processing=${c.processing} succeeded=${c.succeeded} errored=${c.errored}`);
  }
  let usd = 0;
  for await (const r of await client.messages.batches.results(batch.id)) {
    const out = readBatchResult(r.result, ["Ture Lindqvist", "Hedvig Sandberg", "Malte Ek"]);
    usd += out.usage?.usd ?? 0;
    const id = itemIdOf(r.custom_id);
    if (!out.ok) {
      console.log(`  item ${id}: FAILED ${out.reason}`);
      continue;
    }
    const kinds = (k: string) => out.protocol.items.filter((x) => x.kind === k).length;
    const leaked = out.protocol.items.some((x) => /Ture|Hedvig|Malte/.test(`${x.text} ${x.owner ?? ""}`));
    console.log(
      `  item ${id}: date ${out.protocol.date}, ${kinds("topic")} topics, ${kinds("decision")} decisions, ${kinds("task")} tasks, ${kinds("report")} reports, names leaked: ${leaked}, $${out.usage.usd.toFixed(4)} (${out.usage.input} in, ${out.usage.output} out)`,
    );
  }
  const total = ledgerAdd(usd, LEDGER);
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s, paid $${usd.toFixed(4)} (batch price), ledger ${LEDGER} $${total.toFixed(4)}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
