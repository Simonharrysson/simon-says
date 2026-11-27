import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Fonts for the generated share image and icons (app/opengraph-image.tsx, app/icon.tsx), both OFL
// from Google Fonts: Instrument Serif (the wordmark, as in components/ui/Wordmark) and Geist
// SemiBold (headlines; next/og bundles only Geist Regular).

const dir = join(process.cwd(), "lib", "og");

export async function wordmarkFont() {
  return { name: "Instrument Serif", data: await readFile(join(dir, "InstrumentSerif-Regular.ttf")), weight: 400 as const, style: "normal" as const };
}

export async function headlineFont() {
  return { name: "Geist", data: await readFile(join(dir, "Geist-SemiBold.ttf")), weight: 600 as const, style: "normal" as const };
}
