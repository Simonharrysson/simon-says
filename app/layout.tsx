import type { Metadata, Viewport } from "next";
import { Familjen_Grotesk, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import "./views.css";
import "@/components/live/live.css";

// Fonts are downloaded at build time and served from our own domain (no Google request
// from the visitor's browser).
const sans = Familjen_Grotesk({ subsets: ["latin"], variable: "--font-familjen", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap", weight: ["400", "500"] });

export const metadata: Metadata = {
  title: { default: "Simon Says — mötesanteckningar som skriver sig själva", template: "%s · Simon Says" },
  description:
    "Öppna en sida på en laptop vid mötesbordet och tryck Starta. Beslut, att göra och vad ni pratar om skrivs live i ert eget Google-dokument. Gratis för föreningar i Linköping.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8f6" },
    { media: "(prefers-color-scheme: dark)", color: "#101214" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="sv" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#innehall">
          Hoppa till innehållet
        </a>
        {children}
      </body>
    </html>
  );
}
