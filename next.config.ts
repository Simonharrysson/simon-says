import type { NextConfig } from "next";

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

export default nextConfig;
