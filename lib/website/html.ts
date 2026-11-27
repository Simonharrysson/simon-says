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
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return NAMED[code] ?? all;
  });
}

/** Only the first 200 KB of a page is read (the start page's links and a board fit easily). */
export const HTML_MAX_CHARS = 200_000;
const ATTRS_MAX = 2_000;
const LABEL_MAX = 200;

type Token = { kind: "text"; text: string } | { kind: "open"; name: string; attrs: string } | { kind: "close"; name: string };

/** Elements whose content is never visible text: skipped up to their end tag. */
const RAW = new Set(["script", "style", "noscript", "template", "svg", "iframe", "title", "textarea", "object"]);
const TAG_NAME = /\/?[a-zA-Z][a-zA-Z0-9-]*/y;

/**
 * A forgiving, linear HTML tokenizer: every search starts where the last one ended, so the work
 * is proportional to the input (no backtracking regexes over the document). An unclosed comment,
 * tag or <script> ends the document there.
 */
export function* htmlTokens(html: string): Generator<Token> {
  const doc = html.length > HTML_MAX_CHARS ? html.slice(0, HTML_MAX_CHARS) : html;
  const lower = doc.toLowerCase();
  let i = 0;
  while (i < doc.length) {
    const lt = doc.indexOf("<", i);
    if (lt < 0) {
      yield { kind: "text", text: doc.slice(i) };
      return;
    }
    if (lt > i) yield { kind: "text", text: doc.slice(i, lt) };
    if (doc.startsWith("<!--", lt)) {
      const end = doc.indexOf("-->", lt + 4);
      if (end < 0) return;
      i = end + 3;
      continue;
    }
    TAG_NAME.lastIndex = lt + 1;
    const m = TAG_NAME.exec(doc);
    if (!m) {
      if (doc[lt + 1] === "!" || doc[lt + 1] === "?") {
        // <!doctype …>, <?xml …?>
        const gt = doc.indexOf(">", lt + 2);
        if (gt < 0) return;
        i = gt + 1;
      } else {
        // A lone "<" ("a < b") is text.
        yield { kind: "text", text: "<" };
        i = lt + 1;
      }
      continue;
    }
    const gt = doc.indexOf(">", lt + 1 + m[0].length);
    if (gt < 0) return;
    i = gt + 1;
    if (m[0][0] === "/") {
      yield { kind: "close", name: m[0].slice(1).toLowerCase() };
      continue;
    }
    const name = m[0].toLowerCase();
    const attrs = doc.slice(lt + 1 + m[0].length, Math.min(gt, lt + 1 + m[0].length + ATTRS_MAX));
    yield { kind: "open", name, attrs };
    if (RAW.has(name) && !attrs.endsWith("/")) {
      const end = lower.indexOf(`</${name}`, i);
      if (end < 0) return;
      const close = doc.indexOf(">", end);
      if (close < 0) return;
      i = close + 1;
    }
  }
}

const BLOCK = new Set(["p", "div", "br", "li", "ul", "ol", "tr", "td", "th", "table", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "nav", "main", "figure", "figcaption", "dd", "dt", "dl", "blockquote", "address", "hr"]);

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/** What a visitor reads: no scripts, styles or markup; one line per block; spaces collapsed. */
export function pageText(html: string): string {
  const parts: string[] = [];
  for (const t of htmlTokens(html)) {
    if (t.kind === "text") parts.push(decodeEntities(t.text));
    else if (BLOCK.has(t.name)) parts.push("\n");
    else if (t.kind === "open" && t.name === "img") parts.push(` ${attr(t.attrs, "alt") ?? ""} `);
    else parts.push(" ");
  }
  return parts
    .join("")
    .replace(/[ \t\u00a0\f\v\r]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

const KEYWORDS: [RegExp, number][] = [
  [/styrelse|board|ledning|förtroendevalda|fortroendevalda/i, 10],
  [/om[-_ ]?oss|about|föreningen|foreningen|organisation|vilka[-_ ]?är[-_ ]?vi|vilka-ar-vi/i, 5],
  [/kontakt|contact/i, 3],
];

function score(text: string): number {
  return KEYWORDS.reduce((best, [re, s]) => (re.test(text) ? Math.max(best, s) : best), 0);
}

const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");

/** Up to `max` links on the same site that most likely lead to the board, best first. */
export function boardLinks(html: string, base: URL, max = 2): URL[] {
  const anchors: { href: string; label: string }[] = [];
  let open: { href: string; label: string } | null = null;
  for (const t of htmlTokens(html)) {
    if (t.kind === "open" && t.name === "a") {
      const href = attr(t.attrs, "href");
      open = href === null ? null : { href, label: "" };
      if (open) anchors.push(open);
    } else if (t.kind === "close" && t.name === "a") open = null;
    else if (t.kind === "text" && open && open.label.length < LABEL_MAX) open.label += decodeEntities(t.text).slice(0, LABEL_MAX);
  }

  const found = new Map<string, { url: URL; score: number; order: number }>();
  let order = 0;
  for (const a of anchors) {
    const raw = a.href.trim();
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
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep it encoded
    }
    const s = Math.max(score(path), score(a.label));
    if (s === 0) continue;
    const prev = found.get(url.href);
    if (!prev || prev.score < s) found.set(url.href, { url, score: s, order: prev?.order ?? order++ });
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    .map((f) => f.url);
}
