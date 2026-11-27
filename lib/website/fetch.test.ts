import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkUrl, MAX_BYTES, safeFetch, type Address, type RawResponse, type Transport } from "./fetch";

// The SSRF guard with a fake resolver and transport: which addresses, redirects and answers are
// refused, and that the connection goes to the address that was checked. Fictional hosts only.

const HTML = ["text/html"];

type Reply = { status?: number; headers?: Record<string, string>; body?: Uint8Array | string; chunks?: number; hang?: boolean };

function net(dns: Record<string, string[]>, pages: Record<string, Reply>) {
  const seen: { url: string; address: string | null }[] = [];
  const resolve = async (host: string): Promise<Address[]> => {
    const list = dns[host];
    if (!list) throw new Error("ENOTFOUND");
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const transport: Transport = async ({ url, address, signal }) => {
    seen.push({ url: url.href, address: address?.address ?? null });
    const r = pages[url.href];
    if (!r) return { status: 404, headers: {}, body: (async function* () {})(), close() {} };
    const bytes = typeof r.body === "string" ? new TextEncoder().encode(r.body) : (r.body ?? new Uint8Array());
    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        if (r.hang) {
          await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
        }
        for (let i = 0; i < (r.chunks ?? 1); i++) yield bytes;
      },
    };
    const res: RawResponse = { status: r.status ?? 200, headers: { "content-type": "text/html; charset=utf-8", ...r.headers }, body, close() {} };
    return res;
  };
  return { resolve, transport, seen };
}

const PUBLIC = "93.184.216.34";

describe("checkUrl", () => {
  it.each([
    "http://exempel.example/",
    "https://user:pw@exempel.example/",
    "https://exempel.example:8443/",
    "https://localhost/",
    "ftp://exempel.example/",
    "javascript:alert(1)",
    "https://exempel/",
  ])("refuses %s", (u) => expect(checkUrl(u)).toBeNull());

  it("accepts https on the default port and drops the fragment", () => {
    expect(checkUrl("https://exempel.example:443/a#b")?.href).toBe("https://exempel.example/a");
  });
});

describe("safeFetch", () => {
  it("fetches a public page, connecting to the address it checked", async () => {
    const n = net({ "klubb.example": [PUBLIC] }, { "https://klubb.example/": { body: "<p>Hej</p>" } });
    const r = await safeFetch("https://klubb.example/", { accept: HTML, ...n });
    expect(r.ok && new TextDecoder().decode(r.bytes)).toBe("<p>Hej</p>");
    expect(n.seen).toEqual([{ url: "https://klubb.example/", address: PUBLIC }]);
  });

  it.each(["127.0.0.1", "10.0.0.8", "169.254.169.254", "::1", "fd00:ec2::254", "::ffff:192.168.0.1"])("refuses a host that resolves to %s", async (ip) => {
    const n = net({ "klubb.example": [ip] }, { "https://klubb.example/": { body: "x" } });
    expect(await safeFetch("https://klubb.example/", { accept: HTML, ...n })).toEqual({ ok: false, reason: "blocked_address" });
    expect(n.seen).toHaveLength(0);
  });

  it("refuses when ANY of the addresses is private (no picking the public one)", async () => {
    const n = net({ "klubb.example": [PUBLIC, "10.0.0.1"] }, { "https://klubb.example/": { body: "x" } });
    expect(await safeFetch("https://klubb.example/", { accept: HTML, ...n })).toMatchObject({ ok: false, reason: "blocked_address" });
  });

  it("refuses IP literals that are private, without asking DNS", async () => {
    const n = net({}, {});
    expect(await safeFetch("https://169.254.169.254/latest/meta-data/", { accept: HTML, ...n })).toMatchObject({ ok: false, reason: "blocked_address" });
    expect(await safeFetch("https://[::1]/", { accept: HTML, ...n })).toMatchObject({ ok: false, reason: "blocked_address" });
  });

  it("follows a redirect to another public page, checking it again", async () => {
    const n = net(
      { "klubb.example": [PUBLIC], "www.klubb.example": ["93.184.216.35"] },
      { "https://klubb.example/": { status: 301, headers: { location: "https://www.klubb.example/" } }, "https://www.klubb.example/": { body: "ok" } },
    );
    const r = await safeFetch("https://klubb.example/", { accept: HTML, ...n });
    expect(r.ok && r.url.href).toBe("https://www.klubb.example/");
    expect(n.seen.map((s) => s.address)).toEqual([PUBLIC, "93.184.216.35"]);
  });

  it("refuses a redirect to a private address", async () => {
    const n = net(
      { "klubb.example": [PUBLIC], "intern.klubb.example": ["192.168.1.1"] },
      { "https://klubb.example/": { status: 302, headers: { location: "https://intern.klubb.example/admin" } } },
    );
    expect(await safeFetch("https://klubb.example/", { accept: HTML, ...n })).toMatchObject({ ok: false, reason: "blocked_address" });
    expect(n.seen).toHaveLength(1);
  });

  it.each(["http://klubb.example/", "https://169.254.169.254/", "https://klubb.example:8080/", "file:///etc/passwd"])("refuses a redirect to %s", async (location) => {
    const n = net({ "klubb.example": [PUBLIC] }, { "https://klubb.example/": { status: 302, headers: { location } } });
    const r = await safeFetch("https://klubb.example/", { accept: HTML, ...n });
    expect(r.ok).toBe(false);
    expect(n.seen).toHaveLength(1);
  });

  it("stops after three redirects", async () => {
    const pages: Record<string, Reply> = {};
    for (let i = 0; i < 6; i++) pages[`https://klubb.example/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    const n = net({ "klubb.example": [PUBLIC] }, pages);
    expect(await safeFetch("https://klubb.example/0", { accept: HTML, ...n })).toEqual({ ok: false, reason: "too_many_redirects" });
    expect(n.seen).toHaveLength(4);
  });

  it("refuses other content types, error statuses and unknown hosts", async () => {
    const n = net(
      { "klubb.example": [PUBLIC] },
      { "https://klubb.example/bild": { headers: { "content-type": "image/png" }, body: "x" }, "https://klubb.example/fel": { status: 500 } },
    );
    expect(await safeFetch("https://klubb.example/bild", { accept: HTML, ...n })).toEqual({ ok: false, reason: "content_type" });
    expect(await safeFetch("https://klubb.example/fel", { accept: HTML, ...n })).toEqual({ ok: false, reason: "http_status", status: 500 });
    expect(await safeFetch("https://okand.example/", { accept: HTML, ...n })).toEqual({ ok: false, reason: "dns" });
  });

  it("caps the body at 2 MB", async () => {
    const n = net({ "klubb.example": [PUBLIC] }, { "https://klubb.example/": { body: new Uint8Array(512 * 1024), chunks: 5 } });
    expect(await safeFetch("https://klubb.example/", { accept: HTML, ...n })).toEqual({ ok: false, reason: "too_large" });
    const declared = net({ "klubb.example": [PUBLIC] }, { "https://klubb.example/": { headers: { "content-length": String(MAX_BYTES + 1) }, body: "x" } });
    expect(await safeFetch("https://klubb.example/", { accept: HTML, ...declared })).toEqual({ ok: false, reason: "too_large" });
  });

  it("gives up after the timeout", async () => {
    const n = net({ "klubb.example": [PUBLIC] }, { "https://klubb.example/": { hang: true } });
    expect(await safeFetch("https://klubb.example/", { accept: HTML, timeoutMs: 50, ...n })).toEqual({ ok: false, reason: "timeout" });
  });

  it("refuses loopback with the real resolver too", async () => {
    expect(await safeFetch("https://127.0.0.1/", { accept: HTML })).toMatchObject({ ok: false, reason: "blocked_address" });
  });

  it("counts the cap after decompression (a small gzip that unpacks to 4 MB is refused)", async () => {
    const bomb = gzipSync(new Uint8Array(MAX_BYTES * 2));
    expect(bomb.byteLength).toBeLessThan(MAX_BYTES / 100);
    const n = net({ "klubb.example": [PUBLIC] }, { "https://klubb.example/": { headers: { "content-encoding": "gzip" }, body: bomb } });
    expect(await safeFetch("https://klubb.example/", { accept: HTML, ...n })).toEqual({ ok: false, reason: "too_large" });
  });

  it("decodes a gzip page", async () => {
    const n = net({ "klubb.example": [PUBLIC] }, { "https://klubb.example/": { headers: { "content-encoding": "gzip" }, body: gzipSync(Buffer.from("<p>Åsa</p>")) } });
    const r = await safeFetch("https://klubb.example/", { accept: HTML, ...n });
    expect(r.ok && Buffer.from(r.bytes).toString()).toBe("<p>Åsa</p>");
  });
});
