import { readFile } from "node:fs/promises";

// Fonts for the generated share image and icons (app/opengraph-image.tsx, app/icon.tsx), both OFL
// from Google Fonts: Instrument Serif (the wordmark, as in components/ui/Wordmark) and Geist
// SemiBold (headlines; next/og bundles only Geist Regular). `new URL(…, import.meta.url)` makes
// the bundler ship the files with the route, so this also works if a route renders per request
// (today they are prerendered at build).

export async function wordmarkFont() {
  return { name: "Instrument Serif", data: await readFile(new URL("./InstrumentSerif-Regular.ttf", import.meta.url)), weight: 400 as const, style: "normal" as const };
}

export async function headlineFont() {
  return { name: "Geist", data: await readFile(new URL("./Geist-SemiBold.ttf", import.meta.url)), weight: 600 as const, style: "normal" as const };
}
