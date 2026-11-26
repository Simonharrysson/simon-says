import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import "./views.css";
import "@/components/live/live.css";

// Fonts are downloaded at build time and served from our own domain (no Google request
// from the visitor's browser).
// Geist Sans + Geist Mono (OFL), pinned by the pinned `next` version.
const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap", weight: ["400", "500"] });
// Instrument Serif (OFL): the wordmark only. Body text stays Geist.
const display = Instrument_Serif({ subsets: ["latin"], variable: "--font-wordmark", display: "swap", weight: "400" });

export const metadata: Metadata = {
  title: { default: "Simon Says — mötesanteckningar som skriver sig själva", template: "%s · Simon Says" },
  description:
    "Öppna en sida på en laptop vid mötesbordet och tryck Starta. Beslut, att göra och vad ni pratar om skrivs live i ert eget Google-dokument. Gratis för föreningar i Linköping.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="sv" className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <body>
        <a className="skip-link" href="#innehall">
          Hoppa till innehållet
        </a>
        {children}
      </body>
    </html>
  );
}
