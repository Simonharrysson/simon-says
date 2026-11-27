import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/origin";
import { PRIVATE_PREFIXES } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: [...PRIVATE_PREFIXES] },
    sitemap: `${appOrigin()}/sitemap.xml`,
  };
}
