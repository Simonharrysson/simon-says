// Writes the fictional summary e-mails (./demo.ts) as HTML + text files for screenshots and for
// looking at in a browser. usage: npx tsx emails/summary/render.ts <outdir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderSummaryEmail } from "@/lib/summaries/email";
import { demoSummaryEmails } from "./demo";

const out = process.argv[2] ?? ".superpowers/meeting-summary";
mkdirSync(out, { recursive: true });
for (const [name, input] of Object.entries(demoSummaryEmails)) {
  const mail = renderSummaryEmail(input);
  writeFileSync(join(out, `${name}.html`), mail.html);
  writeFileSync(join(out, `${name}.txt`), `Ämne: ${mail.subject}\n\n${mail.text}\n`);
}
console.log(`wrote ${Object.keys(demoSummaryEmails).length} e-mails to ${out}`);
