import { iconImage } from "@/lib/og/icon-image";

// Full bleed: iOS rounds the corners itself.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return iconImage(180, 0);
}
