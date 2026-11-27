import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { MotionProvider } from "@/components/motion/MotionProvider";
import { appOrigin } from "@/lib/origin";
import { SITE_NAME } from "@/lib/seo";
import "./globals.css";

// Fonts are downloaded at build time and served from our own domain (no Google request
// from the visitor's browser).
// Geist Sans + Geist Mono (OFL), pinned by the pinned `next` version.
const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap", weight: ["400", "500"] });
// Instrument Serif (OFL): the wordmark only. Body text stays Geist.
const display = Instrument_Serif({ subsets: ["latin"], variable: "--font-wordmark", display: "swap", weight: "400" });

// Public pages add their canonical URL and share cards (lib/seo.ts); the share image and icons
// are files next to this layout (opengraph-image, icon, apple-icon, manifest).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return {
    metadataBase: new URL(appOrigin()),
    applicationName: SITE_NAME,
    title: { default: t("metaTitle"), template: "%s · Simon Says" },
    description: t("metaDescription"),
    openGraph: { type: "website", siteName: SITE_NAME },
    twitter: { card: "summary_large_image" },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

// The UI language (lib/i18n): the `lang` cookie, Swedish by default. Reading it makes every
// route render per request.
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations("common");
  return (
    <html lang={locale} className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <body>
        <NextIntlClientProvider>
          <a className="absolute -top-16 left-4 z-50 rounded-md bg-ink px-4 py-2 text-on-ink no-underline focus:top-3" href="#innehall">
            {t("skipToContent")}
          </a>
          <MotionProvider>{children}</MotionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
