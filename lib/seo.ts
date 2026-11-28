import type { Metadata } from "next";
import type { Locale } from "@/lib/i18n/config";
import { appOrigin } from "@/lib/origin";
import { PUBLIC_PATHS } from "@/lib/seo-paths";

export { PRIVATE_PREFIXES, PUBLIC_PATHS } from "@/lib/seo-paths";

// Search and share metadata for the public pages. The language is a cookie (lib/i18n), so every
// page has exactly one URL: the canonical is that URL, with no hreflang alternates. Crawlers send
// no cookie and see Swedish. The share image comes from app/opengraph-image.tsx (file-based
// metadata wins over this config).

export const SITE_NAME = "Simon Says";

/** Title, description, canonical URL and the OpenGraph/Twitter cards for a public page. */
export function publicMetadata({
  title,
  description,
  path,
  locale,
  absoluteTitle = false,
}: {
  title: string;
  description: string;
  path: (typeof PUBLIC_PATHS)[number];
  locale: Locale;
  /** The landing's title stands alone (no "· Simon Says" template). */
  absoluteTitle?: boolean;
}): Metadata {
  const url = `${appOrigin()}${path}`;
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: locale === "en" ? "en_GB" : "sv_SE",
      url,
      title,
      description,
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

/** JSON-LD for the landing: the product as a web app. No ratings or reviews (we have none). */
export function softwareApplicationJsonLd(description: string): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    url: `${appOrigin()}/`,
    description,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    inLanguage: ["sv", "en"],
    publisher: { "@type": "Organization", name: "Harrysson & Company AB" },
  };
  // Inside <script>: escape "<" so no string can close the tag.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/** JSON-LD for the landing's FAQ: the questions and answers as shown (answers as plain text). */
export function faqJsonLd(items: { question: string; answer: string }[]): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({ "@type": "Question", name: i.question, acceptedAnswer: { "@type": "Answer", text: i.answer } })),
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
