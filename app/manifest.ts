import type { MetadataRoute } from "next";
import common from "@/lib/i18n/messages/sv/common.json";

// Swedish (the default language): the manifest is fetched without the language cookie.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Simon Says",
    short_name: "Simon Says",
    description: common.metaDescription,
    lang: "sv",
    start_url: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#fafafa",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
