import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/origin";
import { PUBLIC_PATHS } from "@/lib/seo";

// The public pages only (lib/seo.ts). One URL each: the language is a cookie, not a path.
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = appOrigin();
  return PUBLIC_PATHS.map((path) => ({
    url: `${origin}${path}`,
    changeFrequency: path === "/status" ? "hourly" : "monthly",
    priority: path === "/" ? 1 : 0.5,
  }));
}
