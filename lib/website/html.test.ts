import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boardLinks, decodeEntities, decodeHtml, HTML_MAX_CHARS, pageText } from "./html";

// A fictional förening's start page (lib/website/fixtures): no real association or person.
const HOME = readFileSync(new URL("./fixtures/forening-home.html", import.meta.url), "utf8");
const BASE = new URL("https://schackklubben-loparen.example/");

describe("pageText", () => {
  it("keeps what a visitor reads, one block per line, without scripts, styles or comments", () => {
    const text = pageText(HOME);
    expect(text).toContain("Välkommen till Schackklubben Löparen");
    expect(text).toContain("Vi spelar schack varje onsdag i Folkets hus.\nNya medlemmar är välkomna – ingen anmälan behövs.");
    expect(text).toContain("Klubbens bord");
    expect(text).not.toContain("Dold Person");
    expect(text).not.toContain("color");
    expect(text).not.toContain("Gammal Ordförande");
    expect(text).not.toContain("<");
  });

  it("decodes entities", () => {
    expect(decodeEntities("&Aring;sa &amp; &#196;rla &#xe9;&nbsp;x &bogus;")).toBe("Åsa & Ärla é x &bogus;");
  });
});

describe("boardLinks", () => {
  it("picks same-site https pages about the board first, then Om oss and Kontakt", () => {
    const links = boardLinks(HOME, BASE, 5).map((u) => u.href);
    expect(links).toEqual([
      "https://schackklubben-loparen.example/f%C3%B6reningen/styrelse",
      "https://www.schackklubben-loparen.example/styrelse",
      "https://schackklubben-loparen.example/om-oss/",
      "https://schackklubben-loparen.example/kontakt.html",
    ]);
  });

  it("returns at most two by default", () => {
    expect(boardLinks(HOME, BASE)).toHaveLength(2);
  });

  it("never offers other sites, http, files, mail or anchors", () => {
    const hrefs = boardLinks(HOME, BASE, 10).map((u) => u.href).join(" ");
    expect(hrefs).not.toMatch(/forbundet|http:|\.pdf|mailto|#/);
  });
});

describe("decodeHtml", () => {
  const latin1 = Buffer.from("<p>Åsa Öberg, kassör</p>", "latin1");

  it("uses the charset from the header", () => {
    expect(decodeHtml(latin1, "iso-8859-1")).toBe("<p>Åsa Öberg, kassör</p>");
  });

  it("uses <meta charset> when the header has none", () => {
    const bytes = Buffer.concat([Buffer.from('<meta charset="windows-1252">'), latin1]);
    expect(decodeHtml(bytes, null)).toContain("Åsa Öberg");
  });

  it("falls back to UTF-8, also for an unknown label", () => {
    expect(decodeHtml(Buffer.from("<p>Åsa</p>"), "x-bogus")).toBe("<p>Åsa</p>");
  });
});

describe("hostile pages stay cheap (linear work, first 200 KB only)", () => {
  const timed = (fn: () => unknown) => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };

  it("200k unclosed <a x>", () => {
    const html = "<a x>".repeat(200_000);
    expect(timed(() => boardLinks(html, BASE))).toBeLessThan(200);
    expect(timed(() => pageText(html))).toBeLessThan(200);
  });

  it("200k unclosed <script>", () => {
    const html = "<script>".repeat(200_000);
    expect(timed(() => pageText(html))).toBeLessThan(200);
    expect(timed(() => boardLinks(html, BASE))).toBeLessThan(200);
  });

  it("many lone < and unclosed comments and tags", () => {
    for (const html of ["a < ".repeat(200_000), "<!--".repeat(200_000), "<a href='".repeat(200_000), `<a href="/styrelse">${"x".repeat(1_000_000)}`]) {
      expect(timed(() => pageText(html))).toBeLessThan(200);
      expect(timed(() => boardLinks(html, BASE))).toBeLessThan(200);
    }
  });

  it("ignores everything after the first 200 KB", () => {
    const html = `${"<p>x</p>".repeat(HTML_MAX_CHARS / 8)}<a href="/styrelse">Styrelse</a>`;
    expect(boardLinks(html, BASE)).toEqual([]);
  });

  it("keeps a < that isn't a tag as text", () => {
    expect(pageText("<p>3 < 5 och 7 > 2</p>")).toBe("3 < 5 och 7 > 2");
  });
});
