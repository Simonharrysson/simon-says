// The end-to-end test mode (e2e/, `npm run e2e`): a test-only sign-in route and fake Google
// endpoints. It can only switch on for a local dev server against a local Supabase:
//
//   - E2E_TEST_MODE is exactly "1",
//   - NODE_ENV is not "production" (`next build`/`next start` and every Vercel deployment set it),
//   - not on Vercel at all (VERCEL / VERCEL_ENV unset),
//   - SUPABASE_URL is a loopback address (http://127.0.0.1 / localhost / [::1]); any other host,
//     the production project above all, refuses.
//
// Any one condition failing means off. Never import this to decide anything else.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

type Source = Record<string, string | undefined>;

/** Why the e2e mode is off, or null when it is on. */
export function e2eRefusal(source: Source = process.env): string | null {
  if (source.E2E_TEST_MODE !== "1") return "E2E_TEST_MODE is not 1";
  if (source.NODE_ENV === "production") return "NODE_ENV is production";
  if (source.VERCEL || source.VERCEL_ENV) return "running on Vercel";
  let host: string;
  try {
    host = new URL(source.SUPABASE_URL ?? "").hostname;
  } catch {
    return "SUPABASE_URL is not a URL";
  }
  if (!LOOPBACK.has(host)) return "SUPABASE_URL is not a local Supabase";
  return null;
}

/** True only for a local dev server in the e2e test mode (see the conditions above). */
export function e2eMode(source: Source = process.env): boolean {
  return e2eRefusal(source) === null;
}

let warned = false;

/**
 * The fake Google server's root (`E2E_GOOGLE_ROOT`, ends with "/") for the Docs/Drive clients and
 * the OAuth token endpoint, or undefined: Google itself. Ignored (with one warning) outside the
 * e2e mode, so a stray value can never redirect real Google traffic.
 */
export function e2eGoogleRoot(source: Source = process.env): string | undefined {
  const root = source.E2E_GOOGLE_ROOT;
  if (!root) return undefined;
  if (!e2eMode(source)) {
    if (!warned) console.warn(`E2E_GOOGLE_ROOT is set but ignored: ${e2eRefusal(source)}`);
    warned = true;
    return undefined;
  }
  const url = new URL(root);
  if (!LOOPBACK.has(url.hostname)) throw new Error("E2E_GOOGLE_ROOT must be a loopback URL");
  return root.endsWith("/") ? root : `${root}/`;
}
