// The förening's logo (onboarding step 1, migration 0035): a square image the browser crops and
// resizes before upload, stored privately at `org-logos/<org id>/logo` and shown only on the
// förening page and in lists (never in the Docs). Pure helpers shared by the browser and the route.

export const LOGO_BUCKET = "org-logos";
export const LOGO_SIZE = 256;
/** The stored file's cap (the bucket refuses larger ones too). */
export const LOGO_MAX_BYTES = 1024 * 1024;
/** What the browser accepts before resizing (a phone photo is fine; it shrinks to 256 px). */
export const LOGO_MAX_INPUT_BYTES = 15 * 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

export const logoPath = (orgId: string) => `${orgId}/logo`;
export const isLogoType = (t: unknown): t is LogoType => typeof t === "string" && (LOGO_TYPES as readonly string[]).includes(t);

/** The centred square of a w×h image: the source rectangle to draw. */
export function squareCrop(w: number, h: number): { sx: number; sy: number; size: number } {
  const size = Math.max(1, Math.min(w, h));
  return { sx: Math.floor((w - size) / 2), sy: Math.floor((h - size) / 2), size };
}

/** The logo's URL (same origin, member-checked), versioned so a new logo is never a cached old one. */
export function logoUrl(orgId: string, updatedAt: string | null | undefined): string | null {
  if (!updatedAt) return null;
  return `/api/orgs/${orgId}/logo?v=${encodeURIComponent(Date.parse(updatedAt).toString(36))}`;
}

/**
 * The file type from its first bytes (PNG, JPEG, WebP), or null. The route trusts this, not the
 * browser's content type, so nothing else (an SVG, HTML) is ever stored or served as a logo.
 */
export function sniffImage(bytes: Uint8Array): LogoType | null {
  const b = (i: number) => bytes[i];
  if (bytes.length >= 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return "image/png";
  if (bytes.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(b(0), b(1), b(2), b(3)) === "RIFF" && String.fromCharCode(b(8), b(9), b(10), b(11)) === "WEBP") return "image/webp";
  return null;
}
