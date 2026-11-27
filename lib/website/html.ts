// Reading a fetched page without a DOM: the text a visitor sees (for Claude) and the links that
// probably lead to the board ("Styrelse", "Om oss", "Kontakt"). Pure; tested on fictional pages.

/** The page as text, decoded by the declared charset (header, then <meta>), else UTF-8. */
export function decodeHtml(bytes: Uint8Array, headerCharset: string | null): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const meta = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i)?.[1];
  for (const label of [headerCharset, meta, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label.toLowerCase()).decode(bytes);
    } catch {
      // unknown label: try the next
    }
  }
  return new TextDecoder().decode(bytes);
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", shy: "",
  aring: "å", Aring: "Å", auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", eacute: "é", Eacute: "É", uuml: "ü", Uuml: "Ü",
  aelig: "æ", AElig: "Æ", oslash: "ø", Oslash: "Ø", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return NAMED[code] ?? all;
  });
}

const BLOCK = /<\/?(p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|figure|figcaption|dd|dt|dl|blockquote|address|hr)\b[^>]*>/gi;

/** What a visitor reads: no scripts, styles or markup; one line per block; spaces collapsed. */
export function pageText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<img\b[^>]*\balt\s*=\s*"([^"]*)"[^>]*>/gi, " $1 ")
      .replace(BLOCK, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t \f\v]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

const KEYWORDS: [RegExp, number][] = [
  [/styrelse|board|styrelsen|ledning|förtroendevalda|fortroendevalda/i, 10],
  [/om[-_ ]?oss|about|om[-_ ]?föreningen|om[-_ ]?foreningen|föreningen|foreningen|organisation|vilka[-_ ]?är[-_ ]?vi|vilka-ar-vi/i, 5],
  [/kontakt|contact/i, 3],
];

function score(text: string): number {
  return KEYWORDS.reduce((best, [re, s]) => (re.test(text) ? Math.max(best, s) : best), 0);
}

const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");

/** Up to `max` links on the same site that most likely lead to the board, best first. */
export function boardLinks(html: string, base: URL, max = 2): URL[] {
  const found = new Map<string, { url: URL; score: number; order: number }>();
  let order = 0;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = m[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const raw = decodeEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim());
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw)) continue;
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !sameSite(url, base)) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?)$/i.test(url.pathname)) continue;
    url.hash = "";
    if (url.href === base.href) continue;
    const label = decodeEntities(m[2].replace(/<[^>]*>/g, " "));
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep it encoded
    }
    const s = Math.max(score(path), score(label));
    if (s === 0) continue;
    const prev = found.get(url.href);
    if (!prev || prev.score < s) found.set(url.href, { url, score: s, order: prev?.order ?? order++ });
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    .map((f) => f.url);
}
