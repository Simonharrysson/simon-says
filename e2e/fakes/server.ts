import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { startFakeElevenLabs } from "@/scripts/fake-elevenlabs";
import { ClaudeFake } from "./claude";
import { GoogleFake, readBody, send } from "./google";

// One process for every external service the e2e app talks to (see docs/testing.md "E2E"):
//
//   http://127.0.0.1:<port>/…            OAuth /token, Docs /v1, Drive /drive/v3  (E2E_GOOGLE_ROOT)
//   http://127.0.0.1:<port>/anthropic/…  Claude messages, streamed         (ANTHROPIC_BASE_URL)
//   http://127.0.0.1:<port>/__e2e/…      control API for the specs (seed files, read Docs, calls)
//   http://127.0.0.1:<port>/resend/emails  mail, Resend-shaped          (E2E_MAIL_URL)
//   ws://127.0.0.1:<port+1>/v1/speech-to-text/realtime   scripts/fake-elevenlabs.ts (ELEVENLABS_WS_URL)

export async function startFakes(port: number, opts: { segmentSeconds?: number; quiet?: boolean } = {}) {
  const google = new GoogleFake();
  const claude = new ClaudeFake();
  const log = opts.quiet ? () => {} : (line: string) => console.log(line);

  /** Mail the app sent through the fake Resend (POST /resend/emails). */
  const mails: { at: string; to: string[]; subject: string; text: string; html?: string; reply_to?: string; headers?: Record<string, string> }[] = [];
  async function resend(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const body = JSON.parse((await readBody(req)).toString());
    const to = (body.to as string[]).map((t) => t.toLowerCase());
    // "+fail" addresses are refused like an invalid recipient; "+slow" get a 500 (uncertain).
    if (to.some((t) => t.includes("+fail"))) return send(res, 422, { name: "validation_error", message: "Invalid `to` field." });
    if (to.some((t) => t.includes("+slow"))) return send(res, 500, { name: "internal_server_error", message: "fake outage" });
    mails.push({ at: new Date().toISOString(), to, subject: body.subject, text: body.text, html: body.html, reply_to: body.reply_to, headers: body.headers });
    return send(res, 200, { id: `e2e-mail-${mails.length}` });
  }

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname.replace(/^\/+/, "");
    if (path.startsWith("anthropic/")) return void claude.handle(req, res, path.slice("anthropic/".length));
    if (path.startsWith("__e2e/")) return void control(req, res, path.slice("__e2e/".length), url);
    if (path === "resend/emails" && req.method === "POST") return void resend(req, res);
    // Google at the root: googleapis resolves its paths against rootUrl's origin.
    log(`[fake-google] ${req.method} ${url.pathname}`);
    return void google.handle(req, res, path, url);
  });

  async function control(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, path: string, url: URL) {
    try {
      const body = req.method === "POST" ? JSON.parse((await readBody(req)).toString() || "{}") : null;
      let m: RegExpMatchArray | null;
      if (path === "health") return send(res, 200, { ok: true });
      if (path === "google/files" && req.method === "POST") return send(res, 200, google.createFile(body));
      if (path === "google/files" && req.method === "GET") {
        const name = url.searchParams.get("nameContains") ?? "";
        const files = [...google.files.values()].filter((f) => f.name.includes(name));
        return send(res, 200, files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, owner: f.owner, trashed: f.trashed })));
      }
      if ((m = path.match(/^google\/docs\/([^/]+)$/))) {
        const view = google.docView(m[1]);
        return view ? send(res, 200, view) : send(res, 404, { error: "no such doc" });
      }
      if (path === "google/unshareable" && req.method === "POST") {
        google.unshareable.add(String(body.email).toLowerCase());
        return send(res, 200, { ok: true });
      }
      if (path === "claude/calls") {
        const kind = url.searchParams.get("kind");
        const contains = url.searchParams.get("contains");
        return send(res, 200, claude.calls.filter((c) => (!kind || c.kind === kind) && (!contains || c.text.includes(contains))));
      }
      if (path === "mail") {
        const to = (url.searchParams.get("to") ?? "").toLowerCase();
        return send(res, 200, mails.filter((m) => !to || m.to.includes(to)));
      }
      if (path === "problems") return send(res, 200, [...google.problems, ...claude.problems]);
      return send(res, 404, { error: `fake control: no route ${path}` });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  const el = await startFakeElevenLabs({ port: port + 1, segmentSeconds: opts.segmentSeconds ?? 1, log });
  return {
    google,
    claude,
    el,
    close: async () => {
      await el.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.E2E_FAKE_PORT ?? 4010);
  await startFakes(port);
  console.log(`e2e fakes: http://127.0.0.1:${port} (Google, Claude, control) and ws://127.0.0.1:${port + 1} (ElevenLabs)`);
}
