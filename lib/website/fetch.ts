import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { pipeline, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isBlockedAddress } from "./ip";

// A careful GET of someone else's public web page (SSRF guard). Rules, all enforced here:
//   - https only, the default port only, no user:password@ in the URL;
//   - the host name is resolved once and EVERY address it gives must be public (lib/website/ip.ts);
//     the connection then goes to that checked address (no second lookup: no DNS rebinding);
//   - redirects are followed by hand, at most MAX_REDIRECTS, each hop checked like the first;
//   - a deadline per request (5 s) and a size cap counted after decompression (2 MB);
//   - only the content types the caller accepts (text/html for pages, text/plain for robots.txt);
//   - a generic User-Agent, no cookies, no personal data in any header.
// Returns a reason code instead of throwing; codes (never URLs or page text) are what gets logged.

export const USER_AGENT = "Mozilla/5.0 (compatible; SimonSaysBot/1.0)";
/** The token robots.txt rules are matched against (lowercase). */
export const ROBOTS_TOKEN = "simonsaysbot";
export const FETCH_TIMEOUT_MS = 5_000;
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

export type FetchFailure =
  | "bad_url"
  | "dns"
  | "blocked_address"
  | "too_many_redirects"
  | "http_status"
  | "content_type"
  | "too_large"
  | "timeout"
  | "network";

export type FetchResult =
  | { ok: true; url: URL; contentType: string; charset: string | null; bytes: Uint8Array }
  | { ok: false; reason: FetchFailure; status?: number };

export interface Address {
  address: string;
  family: number;
}

/** One HTTP exchange's head and its body as sent (still Content-Encoded). */
export interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Stop reading and close the connection. */
  close(): void;
}

export type Resolver = (host: string) => Promise<Address[]>;
export type Transport = (req: { url: URL; address: Address | null; headers: Record<string, string>; signal: AbortSignal }) => Promise<RawResponse>;

export interface SafeFetchOptions {
  /** Which content types (lowercase, no parameters) to accept. */
  accept: string[];
  maxBytes?: number;
  timeoutMs?: number;
  resolve?: Resolver;
  transport?: Transport;
  /** Aborts this fetch too (the caller's overall deadline). */
  signal?: AbortSignal;
  /**
   * e2e only (lib/e2e/guard.ts `e2eWebRoot`): a loopback origin that stands in for every host.
   * The address checks are skipped because nothing leaves the machine; URL rules still apply.
   */
  e2eRoot?: string;
}

/** The URL rules (https, default port, no credentials, a real host). Null when refused. */
export function checkUrl(raw: string | URL, base?: URL): URL | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || (!isIP(host) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i.test(host))) return null;
  url.hash = "";
  return url;
}

const systemResolver: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

/** The body after Content-Encoding (the size cap counts these bytes, so a zip bomb can't slip by). */
function decoded(body: AsyncIterable<Uint8Array>, encoding: string | undefined): AsyncIterable<Uint8Array> {
  const enc = (encoding ?? "").toLowerCase().trim();
  const unzip = enc === "gzip" || enc === "x-gzip" ? createGunzip() : enc === "deflate" ? createInflate() : enc === "br" ? createBrotliDecompress() : null;
  if (!unzip) return body;
  // pipeline (not .pipe): an error or abort in the source reaches the decoder, so the read loop
  // ends with that error instead of waiting forever.
  pipeline(Readable.from(body), unzip, () => {});
  return unzip;
}

/** The real transport: TLS to the checked address, with the host name for SNI and certificate checks. */
const httpsTransport: Transport = ({ url, address, headers, signal }) =>
  new Promise((resolve, reject) => {
    if (!address) return reject(new Error("no address"));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const req = httpsRequest(
      {
        host,
        servername: isIP(host) ? undefined : host,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { ...headers, "accept-encoding": "gzip, deflate, br" },
        signal,
        // Pinned: the socket connects to the address we checked, never to a fresh lookup.
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          opts?.all ? cb(null, [address]) : cb(null, address.address, address.family)) as never,
      },
      (res) => {
        const h: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: res.statusCode ?? 0, headers: h, body: res as AsyncIterable<Uint8Array>, close: () => res.destroy() });
      },
    );
    req.on("error", reject);
    req.end();
  });

/** e2e transport: `https://<host>/<path>` → `<root><host>/<path>` on loopback (plain fetch, no redirects). */
function e2eTransport(root: string): Transport {
  return async ({ url, headers, signal }) => {
    const res = await fetch(`${root}${url.host}${url.pathname}${url.search}`, { headers, signal, redirect: "manual" });
    const h: Record<string, string | undefined> = {};
    res.headers.forEach((v, k) => (h[k] = v));
    delete h["content-encoding"]; // fetch already decoded it
    const reader = res.body?.getReader();
    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        if (!reader) return;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      },
    };
    return { status: res.status, headers: h, body, close: () => void reader?.cancel().catch(() => {}) };
  };
}

function mediaType(header: string | undefined): { type: string; charset: string | null } {
  const [type, ...params] = (header ?? "").split(";");
  const charset = params.map((p) => p.trim().match(/^charset="?([^";]+)"?$/i)?.[1]).find(Boolean) ?? null;
  return { type: type.trim().toLowerCase(), charset: charset ? charset.toLowerCase() : null };
}

/** GET `raw` under the rules above. Never throws. */
export async function safeFetch(raw: string | URL, opts: SafeFetchOptions): Promise<FetchResult> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const resolve = opts.resolve ?? systemResolver;
  const transport = opts.transport ?? (opts.e2eRoot ? e2eTransport(opts.e2eRoot) : httpsTransport);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  const outer = opts.signal;
  const onOuter = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", onOuter, { once: true });
  let url = checkUrl(raw);
  try {
    for (let hop = 0; ; hop++) {
      if (!url) return { ok: false, reason: "bad_url" };
      let address: Address | null = null;
      if (!opts.e2eRoot) {
        const host = url.hostname.replace(/^\[|\]$/g, "");
        let addresses: Address[];
        if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
        else {
          try {
            addresses = await resolve(host);
          } catch {
            return { ok: false, reason: controller.signal.aborted ? "timeout" : "dns" };
          }
        }
        if (addresses.length === 0) return { ok: false, reason: "dns" };
        if (addresses.some((a) => isBlockedAddress(a.address))) return { ok: false, reason: "blocked_address" };
        address = addresses[0];
      }

      const res = await transport({
        url,
        address,
        headers: { "user-agent": USER_AGENT, accept: `${opts.accept.join(", ")};q=1, */*;q=0.1`, "accept-language": "sv,en;q=0.8" },
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        res.close();
        if (hop >= MAX_REDIRECTS) return { ok: false, reason: "too_many_redirects" };
        url = checkUrl(res.headers.location, url);
        continue;
      }
      if (res.status !== 200) {
        res.close();
        return { ok: false, reason: "http_status", status: res.status };
      }
      const { type, charset } = mediaType(res.headers["content-type"]);
      if (!opts.accept.includes(type)) {
        res.close();
        return { ok: false, reason: "content_type" };
      }
      const enc = res.headers["content-encoding"];
      if (enc && !["gzip", "x-gzip", "deflate", "br", "identity"].includes(enc.toLowerCase().trim())) {
        res.close();
        return { ok: false, reason: "content_type" };
      }
      const declared = Number(res.headers["content-length"]);
      if (!res.headers["content-encoding"] && Number.isFinite(declared) && declared > maxBytes) {
        res.close();
        return { ok: false, reason: "too_large" };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of decoded(res.body, enc)) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          res.close();
          return { ok: false, reason: "too_large" };
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      return { ok: true, url, contentType: type, charset, bytes };
    }
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
  }
}
