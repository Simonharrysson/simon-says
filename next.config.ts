import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

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
    ];
  },
};

export default withNextIntl(nextConfig);
