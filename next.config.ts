import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { PRIVATE_PREFIXES } from "./lib/seo-paths";

// UI language (sv default, en): cookie-based, no URL prefixes. See lib/i18n/request.ts.
const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts");

const nextConfig: NextConfig = {
  // No page may be framed (clickjacking). A full CSP is a later step.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      // The signed-in area, one-off links and the API stay out of search results (lib/seo-paths.ts;
      // robots.txt disallows the same prefixes).
      ...PRIVATE_PREFIXES.map((prefix) => ({
        source: prefix.endsWith("/") ? `${prefix}:path*` : `${prefix}/:path*`,
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      })),
    ];
  },
};

export default withNextIntl(nextConfig);
