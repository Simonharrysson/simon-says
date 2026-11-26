import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { translator } from "@/lib/i18n/translator";
// The förening's "Om oss" (todo #13, migration 0044): a short plain-text description and links
// to its website, Facebook and Instagram. One parser for Inställningar and Kom igång; it turns what
// an admin typed into the one canonical form the database checks accept (https only, the right
// host exactly, empty = null), or a Swedish sentence per field.

export const ABOUT_MAX = 600;
const URL_MAX = 300;

export interface OrgProfile {
  about: string | null;
  website_url: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
}

export const EMPTY_PROFILE: OrgProfile = { about: null, website_url: null, facebook_url: null, instagram_url: null };

/** What the form sends: the raw text of each field. */
export interface ProfileInput {
  about: string;
  website: string;
  facebook: string;
  instagram: string;
}

export type ProfileField = keyof ProfileInput;
export type ProfileErrors = Partial<Record<ProfileField, string>>;

/** The field errors in the UI language (profile.errors.* in the catalogs). */
export function profileErrors(locale: Locale = defaultLocale): Record<ProfileField, string> {
  const t = translator(locale);
  return {
    about: t("profile.errors.about", { max: ABOUT_MAX }),
    website: t("profile.errors.website"),
    facebook: t("profile.errors.facebook"),
    instagram: t("profile.errors.instagram"),
  };
}

/** Characters as Postgres counts them (code points, not UTF-16 units). */
const length = (s: string) => [...s].length;

/** Plain text: CRLF → LF (textareas send CRLF), no other control characters, trimmed; empty = null. */
export function normalizeAbout(raw: string): string | null | undefined {
  const text = raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  return length(text) <= ABOUT_MAX ? text : undefined;
}

/** A URL the user typed, with https:// added when no scheme was given. Null when it doesn't parse. */
function parseUrl(raw: string): URL | null {
  const text = raw.trim();
  // "exempel.se:8443/x" has a port, not a scheme ("javascript:x" and "https://x" do).
  const withScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) ? text : `https://${text.replace(/^\/+/, "")}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** The website: https only, a real host name (with a dot). Empty = null; undefined = invalid. */
export function normalizeWebsite(raw: string): string | null | undefined {
  if (!raw.trim()) return null;
  if (/\s/.test(raw.trim())) return undefined;
  const url = parseUrl(raw);
  if (!url || !/^[^.]+(\.[^.]+)+$/.test(url.hostname)) return undefined;
  const href = url.href;
  return href.length <= URL_MAX ? href : undefined;
}

const FACEBOOK_HOSTS = new Set(["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"]);
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
const FACEBOOK_NAME = /^[A-Za-z0-9.\-]{1,80}$/;
const INSTAGRAM_NAME = /^[A-Za-z0-9._]{1,30}$/;

/** A bare name ("@exempel", "exempel"), or null when the text looks like a URL. */
function bareName(text: string): string | null {
  if (text.includes("/") || /\.(com|se|net|org)$/i.test(text)) return null;
  return text.replace(/^@/, "");
}

/**
 * The Facebook page: a name ("exempel", "@exempel") or a facebook.com URL. Canonical
 * `https://facebook.com/<path>`; profile.php keeps its `id`. Empty = null; undefined = invalid.
 */
export function normalizeFacebook(raw: string): string | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  if (/\s/.test(text)) return undefined;
  const name = bareName(text);
  if (name !== null) return FACEBOOK_NAME.test(name) ? `https://facebook.com/${name}` : undefined;
  const url = parseUrl(text);
  if (!url || !FACEBOOK_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const path = url.pathname.replace(/\/+$/, "").replace(/^\/+/, "");
  if (!path || !/^[A-Za-z0-9._\-/%]+$/.test(path)) return undefined;
  let out = `https://facebook.com/${path}`;
  if (path === "profile.php") {
    const id = url.searchParams.get("id");
    if (!id || !/^\d{1,30}$/.test(id)) return undefined;
    out += `?id=${id}`;
  }
  return out.length <= URL_MAX ? out : undefined;
}

/**
 * The Instagram account: a handle ("@exempel", "exempel") or an instagram.com URL. Canonical
 * `https://instagram.com/<handle>`. Empty = null; undefined = invalid.
 */
export function normalizeInstagram(raw: string): string | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  if (/\s/.test(text)) return undefined;
  let handle = bareName(text);
  if (handle === null) {
    const url = parseUrl(text);
    if (!url || !INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return undefined;
    handle = parts[0];
  }
  return INSTAGRAM_NAME.test(handle) ? `https://instagram.com/${handle}` : undefined;
}

export type ProfileResult = { ok: true; profile: OrgProfile } | { ok: false; errors: ProfileErrors };

/** Every field at once: the canonical profile, or an error sentence for each field that is wrong. */
export function parseProfile(input: ProfileInput, locale: Locale = defaultLocale): ProfileResult {
  const messages = profileErrors(locale);
  const about = normalizeAbout(input.about);
  const website_url = normalizeWebsite(input.website);
  const facebook_url = normalizeFacebook(input.facebook);
  const instagram_url = normalizeInstagram(input.instagram);
  const errors: ProfileErrors = {};
  if (about === undefined) errors.about = messages.about;
  if (website_url === undefined) errors.website = messages.website;
  if (facebook_url === undefined) errors.facebook = messages.facebook;
  if (instagram_url === undefined) errors.instagram = messages.instagram;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, profile: { about: about!, website_url: website_url!, facebook_url: facebook_url!, instagram_url: instagram_url! } };
}

/** The saved profile, as text for the form fields (Instagram as "@handle"). */
export function profileInput(p: Partial<OrgProfile>): ProfileInput {
  const ig = p.instagram_url?.match(/^https:\/\/instagram\.com\/(.+)$/)?.[1];
  return {
    about: p.about ?? "",
    website: p.website_url ?? "",
    facebook: p.facebook_url ?? "",
    instagram: ig ? `@${ig}` : (p.instagram_url ?? ""),
  };
}

/** Same profile? (decides whether Kom igång needs to save) */
export function sameProfile(a: Partial<OrgProfile>, b: Partial<OrgProfile>): boolean {
  return (["about", "website_url", "facebook_url", "instagram_url"] as const).every((k) => (a[k] ?? null) === (b[k] ?? null));
}

/** Anything to show on the förening page? */
export function hasProfile(p: Partial<OrgProfile>): boolean {
  return Boolean(p.about || p.website_url || p.facebook_url || p.instagram_url);
}

/** The website as people say it: host without www, e.g. "exempel.se". */
export function websiteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
