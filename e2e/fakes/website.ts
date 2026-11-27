import type { IncomingMessage, ServerResponse } from "node:http";

// A fictional förening's website for "Hämta styrelsen från webbplatsen" (E2E_WEB_ROOT): the app
// asks `/web/<host>/<path>` instead of `https://<host>/<path>`. Only FAKE_SITE_HOST exists; every
// other host answers 404 (so a spec that saves any other website fails softly, never reaches the
// internet). Everything here is invented: no real association, person or page.

export const FAKE_SITE_HOST = "kanotklubben-ejdern.example";

export const FAKE_BOARD = [
  { name: "Karin Ekholm", role: "Ordförande" },
  { name: "Jonas Åberg", role: "Kassör" },
  { name: "Åsa Lindqvist", role: "Sekreterare" },
  { name: "Leila Haddad", role: "Ledamot" },
  { name: "Mikael Strand", role: "Ledamot" },
  { name: "Nora Vik", role: "Suppleant" },
];

const page = (title: string, body: string) =>
  `<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:sans-serif}</style></head><body>${body}</body></html>`;

const HOME = page(
  "Kanotklubben Ejdern",
  `<header><nav><a href="/">Hem</a> <a href="/om-oss">Om oss</a> <a href="/styrelse">Styrelse</a> <a href="/intern/protokoll">Protokoll</a> <a href="https://elsewhere.example/styrelse">Förbundets styrelse</a></nav></header>
   <main><h1>Kanotklubben Ejdern</h1><p>Vi paddlar på sjön varje torsdag från maj till september.</p></main>`,
);

const OM_OSS = page("Om oss", `<main><h1>Om oss</h1><p>Klubben grundades av några vänner som ville paddla tillsammans.</p></main>`);

const STYRELSE_BODY = `<main><h1>Styrelse</h1><ul>${FAKE_BOARD.map((p) => `<li>${p.role}: ${p.name}</li>`).join("")}</ul>
  <h2>Valberedning</h2><p>Per Sand</p><script>var ignored = "Inte En Person";</script></main>`;

/** The board page is served as ISO-8859-1, as old association sites often are (å, ä, ö must survive). */
const STYRELSE_LATIN1 = Buffer.from(
  `<!doctype html><html lang="sv"><head><meta charset="iso-8859-1"><title>Styrelse</title></head><body>${STYRELSE_BODY}</body></html>`,
  "latin1",
);

const ROBOTS = "User-agent: *\nDisallow: /intern/\n";

export function handleWebsite(_req: IncomingMessage, res: ServerResponse, path: string): void {
  const [host, ...rest] = path.split("/");
  const route = `/${rest.join("/")}`.replace(/\?.*$/, "");
  const send = (status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  if (host !== FAKE_SITE_HOST) return send(404, "text/plain", "not found");
  if (route === "/robots.txt") return send(200, "text/plain; charset=utf-8", ROBOTS);
  if (route === "/" || route === "") return send(200, "text/html; charset=utf-8", HOME);
  if (route === "/om-oss") return send(200, "text/html; charset=utf-8", OM_OSS);
  if (route === "/styrelse") return send(200, "text/html; charset=iso-8859-1", STYRELSE_LATIN1);
  return send(404, "text/plain", "not found");
}
