import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { docs_v1 } from "@googleapis/docs";
import { apply, docOf, paraEl, TAB } from "@/test/docsim";
import { CalendarFake } from "./calendar";

// The fake Google behind the e2e app (E2E_GOOGLE_ROOT, lib/e2e/guard.ts): the OAuth token
// endpoint, the Docs API (documents.get / batchUpdate) and the parts of Drive v3 the app calls.
// State lives in memory for one run. Docs: one test/docsim Doc per tab, so the measured docsim
// model applies tab by tab; requests docsim does not model answer 400 like Google would.
// Identity: the e2e sign-in stores the refresh token `e2e-refresh:<email>`; its access token is
// `e2e-at:<email>`, so every call knows its user. Everything is visible to everyone (the drive.file
// scoping is not modelled).

type Doc = docs_v1.Schema$Document;
type Req = docs_v1.Schema$Request;

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DOC_MIME = "application/vnd.google-apps.document";

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  owner: string;
  trashed: boolean;
  appProperties: Record<string, string>;
  createdTime: string;
  modifiedTime: string;
  driveId?: string;
  /** Raw bytes (a PDF) or plain text for non-Docs files. */
  content?: Buffer;
  permissions: { id: string; emailAddress: string; role: string }[];
  writersCanShare?: boolean;
}

interface FakeTab {
  tabId: string;
  title: string;
  doc: Doc;
}

interface FakeDoc {
  id: string;
  rev: number;
  tabs: FakeTab[];
}

/** A failed call, kept for the run's report (a 400 the app got, an unmodelled request). */
export interface FakeProblem {
  at: string;
  what: string;
}

const newId = () => `fk${randomBytes(12).toString("hex")}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason = "badRequest",
  ) {
    super(message);
  }
}

const textOfTab = (doc: Doc) =>
  (doc.tabs?.[0]?.documentTab?.body?.content ?? [])
    .flatMap((el) => [
      ...(el.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? ""),
      ...(el.table?.tableRows ?? []).flatMap((r) =>
        (r.tableCells ?? []).flatMap((c) => (c.content ?? []).flatMap((p) => (p.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? ""))),
      ),
    ])
    .join("");

export class GoogleFake {
  readonly files = new Map<string, FakeFile>();
  readonly docs = new Map<string, FakeDoc>();
  readonly problems: FakeProblem[] = [];
  /** Emails a share (permissions.create) fails for, like an address without a Google account. */
  readonly unshareable = new Set<string>();
  /** The read-only Calendar API (calendarList, events), per user e-mail. */
  readonly calendar = new CalendarFake();

  // ---------------------------------------------------------------------------------------------
  // Control (tests)

  createFile(input: {
    name: string;
    mimeType?: string;
    parents?: string[];
    owner?: string;
    paragraphs?: { text: string; style?: string }[];
    content?: string;
    modifiedTime?: string;
    createdTime?: string;
    appProperties?: Record<string, string>;
  }): FakeFile {
    const now = new Date().toISOString();
    const file: FakeFile = {
      id: newId(),
      name: input.name,
      mimeType: input.mimeType ?? DOC_MIME,
      parents: input.parents ?? ["root"],
      owner: input.owner ?? "someone@e2e.test",
      trashed: false,
      appProperties: input.appProperties ?? {},
      createdTime: input.createdTime ?? now,
      modifiedTime: input.modifiedTime ?? now,
      permissions: [],
      ...(input.content !== undefined ? { content: Buffer.from(input.content) } : {}),
    };
    this.files.set(file.id, file);
    if (file.mimeType === DOC_MIME) {
      const paras = (input.paragraphs ?? [{ text: "" }]).map((p) => paraEl(p.text, { style: p.style }));
      this.docs.set(file.id, { id: file.id, rev: 1, tabs: [{ tabId: "t.0", title: "Flik 1", doc: docOf(paras.length ? paras : [paraEl("")]) }] });
    }
    return file;
  }

  /** A Doc's tabs as plain text (each tab's paragraphs, tables flattened). */
  docView(id: string) {
    const file = this.files.get(id);
    const doc = this.docs.get(id);
    if (!file || !doc) return null;
    return {
      id,
      name: file.name,
      parents: file.parents,
      owner: file.owner,
      trashed: file.trashed,
      permissions: file.permissions.map((p) => p.emailAddress),
      appProperties: file.appProperties,
      tabs: doc.tabs.map((t) => ({ tabId: t.tabId, title: t.title, text: textOfTab(t.doc) })),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // HTTP

  async handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    try {
      const body = method === "GET" || method === "DELETE" ? null : await readBody(req);
      if (path === "token" && method === "POST") return send(res, 200, this.token(body?.toString() ?? ""));
      if (path === "o/oauth2/v2/auth" && method === "GET") return this.authorize(res, url);
      if (path === "tokeninfo" && method === "POST") return send(res, 200, this.tokeninfo(body?.toString() ?? ""));
      const user = this.user(req);
      const json = () => (body && body.length ? (JSON.parse(body.toString()) as Record<string, unknown>) : {});

      const cal = this.calendar.handle(method, path, url, user);
      if (cal) return send(res, cal.status, cal.body);
      let m: RegExpMatchArray | null;
      if ((m = path.match(/^v1\/documents\/([^/:]+)$/)) && method === "GET") return send(res, 200, this.getDoc(m[1], url));
      if ((m = path.match(/^v1\/documents\/([^/:]+):batchUpdate$/)) && method === "POST") return send(res, 200, this.batchUpdate(m[1], json()));
      if (path === "drive/v3/files" && method === "GET") return send(res, 200, this.list(url, user));
      if (path === "drive/v3/files" && method === "POST") return send(res, 200, this.create(json(), user));
      if (path === "drive/v3/drives" && method === "GET") return send(res, 200, { drives: [] });
      if ((m = path.match(/^drive\/v3\/files\/([^/]+)\/export$/)) && method === "GET") return sendRaw(res, this.exportText(m[1]), "text/plain; charset=utf-8");
      if ((m = path.match(/^drive\/v3\/files\/([^/]+)\/permissions$/)) && method === "POST") return send(res, 200, this.share(m[1], json()));
      if ((m = path.match(/^drive\/v3\/files\/([^/]+)\/permissions$/)) && method === "GET") {
        const f = this.file(m[1]);
        return send(res, 200, { permissions: f.permissions.map((p) => ({ kind: "drive#permission", id: p.id, emailAddress: p.emailAddress, role: p.role, type: "user" })) });
      }
      if ((m = path.match(/^drive\/v3\/files\/([^/]+)\/permissions\/([^/]+)$/)) && method === "DELETE") {
        const f = this.file(m[1]);
        const before = f.permissions.length;
        f.permissions = f.permissions.filter((p) => p.id !== m![2]);
        if (f.permissions.length === before) throw new HttpError(404, `Permission not found: ${m[2]}.`, "notFound");
        res.writeHead(204);
        return void res.end();
      }
      if ((m = path.match(/^drive\/v3\/files\/([^/]+)$/))) {
        const file = this.file(m[1]);
        if (method === "GET") {
          if (url.searchParams.get("alt") === "media") return sendRaw(res, file.content ?? Buffer.from(this.exportText(file.id)), "application/octet-stream");
          return send(res, 200, this.meta(file));
        }
        if (method === "PATCH") return send(res, 200, this.update(file, json(), url));
      }
      throw new HttpError(404, `fake google: no route ${method} ${path}`, "notFound");
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, (err as Error).message ?? String(err), "backendError");
      if (e.status >= 500 || e.reason === "badRequest") this.problems.push({ at: new Date().toISOString(), what: `${method} ${path}: ${e.status} ${e.message}` });
      return send(res, e.status, { error: { code: e.status, message: e.message, errors: [{ reason: e.reason, message: e.message }], status: e.reason } });
    }
  }

  /** The account Google's consent screen "picks" next (`login_hint` wins); the e2e default otherwise. */
  oauthAccount = "styrelsen@forening.e2e.test";

  /**
   * Google's consent screen for "Använd ett annat Google-konto" (0070): answers at once with a code
   * for the picked account (an address with "+deny" cancels, like "Avbryt").
   */
  private authorize(res: ServerResponse, url: URL) {
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    const state = url.searchParams.get("state") ?? "";
    const email = (url.searchParams.get("login_hint") || this.oauthAccount).toLowerCase();
    if (!url.searchParams.get("code_challenge") || url.searchParams.get("code_challenge_method") !== "S256") throw new HttpError(400, "PKCE required");
    if (email.includes("+deny")) back.searchParams.set("error", "access_denied");
    else back.searchParams.set("code", `e2e-code:${email}`);
    back.searchParams.set("state", state);
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  /** tokeninfo for an access token: our client, the account's id and address, its scopes. */
  private tokeninfo(form: string) {
    const at = new URLSearchParams(form).get("access_token") ?? "";
    if (!at.startsWith("e2e-at:")) throw new HttpError(400, "invalid_token");
    const email = at.slice("e2e-at:".length);
    return { aud: "e2e-client", azp: "e2e-client", sub: `e2e-sub-${email}`, email, email_verified: "true", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file" };
  }

  private token(form: string) {
    const params = new URLSearchParams(form);
    if (params.get("grant_type") === "authorization_code") {
      const code = params.get("code") ?? "";
      if (!code.startsWith("e2e-code:") || !params.get("code_verifier")) throw new HttpError(400, "invalid_grant");
      const email = code.slice("e2e-code:".length);
      return { access_token: `e2e-at:${email}`, refresh_token: `e2e-refresh:${email}`, expires_in: 3599, token_type: "Bearer", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file" };
    }
    const refresh = params.get("refresh_token") ?? "";
    if (params.get("grant_type") !== "refresh_token" || !refresh.startsWith("e2e-refresh:")) {
      throw new HttpError(400, "invalid_grant");
    }
    return {
      access_token: `e2e-at:${refresh.slice("e2e-refresh:".length)}`,
      expires_in: 3599,
      token_type: "Bearer",
      scope: "openid email profile https://www.googleapis.com/auth/drive.file",
    };
  }

  private user(req: IncomingMessage): string {
    const auth = req.headers.authorization ?? "";
    const m = auth.match(/^Bearer e2e-at:(.+)$/);
    return m ? m[1] : "";
  }

  private file(id: string): FakeFile {
    const f = this.files.get(id);
    if (!f) throw new HttpError(404, `File not found: ${id}.`, "notFound");
    return f;
  }

  private meta(f: FakeFile) {
    return {
      kind: "drive#file",
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      trashed: f.trashed,
      appProperties: f.appProperties,
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime,
      ...(f.driveId ? { driveId: f.driveId } : {}),
      ...(f.content ? { size: String(f.content.length) } : {}),
      owners: [{ emailAddress: f.owner, me: true }],
      capabilities: { canEdit: true, canAddChildren: f.mimeType === FOLDER_MIME, canShare: true },
    };
  }

  private create(body: Record<string, unknown>, user: string) {
    const name = String(body.name ?? "Namnlöst dokument");
    const file = this.createFile({
      name,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : DOC_MIME,
      parents: Array.isArray(body.parents) ? (body.parents as string[]) : ["root"],
      owner: user,
      appProperties: (body.appProperties as Record<string, string>) ?? {},
    });
    if (body.writersCanShare === false) file.writersCanShare = false;
    return this.meta(file);
  }

  private update(f: FakeFile, body: Record<string, unknown>, url: URL) {
    if (typeof body.trashed === "boolean") f.trashed = body.trashed;
    if (typeof body.name === "string") f.name = body.name;
    if (body.appProperties) Object.assign(f.appProperties, body.appProperties);
    const add = url.searchParams.get("addParents");
    const remove = url.searchParams.get("removeParents");
    if (remove) f.parents = f.parents.filter((p) => !remove.split(",").includes(p));
    if (add) f.parents.push(...add.split(","));
    f.modifiedTime = new Date().toISOString();
    return this.meta(f);
  }

  private share(id: string, body: Record<string, unknown>) {
    const f = this.file(id);
    const email = String(body.emailAddress ?? "").toLowerCase();
    if (!email || this.unshareable.has(email)) throw new HttpError(400, `Invalid sharing request: ${email} has no Google account.`, "invalidSharingRequest");
    // As Drive: an address that already has access gets its existing permission back.
    const had = f.permissions.find((p) => p.emailAddress === email);
    const perm = had ?? { id: newId(), emailAddress: email, role: String(body.role ?? "writer") };
    if (!had) f.permissions.push(perm);
    return { kind: "drive#permission", id: perm.id, role: perm.role, type: "user" };
  }

  private exportText(id: string): string {
    const f = this.file(id);
    const doc = this.docs.get(id);
    if (!doc) return f.content?.toString() ?? "";
    return doc.tabs.map((t) => textOfTab(t.doc)).join("\n");
  }

  private list(url: URL, user: string) {
    const q = url.searchParams.get("q") ?? "";
    const match = parseQuery(q);
    const files = [...this.files.values()].filter((f) => match(f, user));
    const size = Number(url.searchParams.get("pageSize") ?? 100);
    return { kind: "drive#fileList", incompleteSearch: false, files: files.slice(0, size).map((f) => this.meta(f)) };
  }

  // ---------------------------------------------------------------------------------------------
  // Docs

  private doc(id: string): FakeDoc {
    const d = this.docs.get(id);
    if (!d) throw new HttpError(404, `Requested entity was not found: document ${id}`, "notFound");
    return d;
  }

  private render(d: FakeDoc, withTabs: boolean): Doc {
    const file = this.files.get(d.id);
    const tabs = d.tabs.map((t, index) => ({
      tabProperties: { tabId: t.tabId, title: t.title, index },
      documentTab: clone(t.doc.tabs![0].documentTab!),
    }));
    const base = { documentId: d.id, title: file?.name ?? "", revisionId: `rev-${d.id.slice(-6)}-${d.rev}` };
    if (withTabs) return { ...base, tabs };
    const first = tabs[0].documentTab;
    return { ...base, body: first.body, namedRanges: first.namedRanges, lists: first.lists };
  }

  private getDoc(id: string, url: URL): Doc {
    return this.render(this.doc(id), url.searchParams.get("includeTabsContent") === "true");
  }

  private batchUpdate(id: string, body: { requests?: Req[]; writeControl?: { requiredRevisionId?: string } }) {
    const d = this.doc(id);
    const current = this.render(d, false).revisionId;
    const required = body.writeControl?.requiredRevisionId;
    if (required && required !== current) {
      throw new HttpError(400, `The required revision ID '${required}' does not match the latest revision of the document.`, "failedPrecondition");
    }
    const tabs = clone(d.tabs);
    const replies: Record<string, unknown>[] = [];
    (body.requests ?? []).forEach((r, i) => {
      try {
        replies.push(applyOne(tabs, r));
      } catch (err) {
        throw new HttpError(400, `Invalid requests[${i}].${Object.keys(r)[0]}: ${(err as Error).message}`);
      }
    });
    d.tabs = tabs;
    d.rev++;
    const file = this.files.get(id);
    if (file) file.modifiedTime = new Date().toISOString();
    return { documentId: id, replies, writeControl: { requiredRevisionId: this.render(d, false).revisionId } };
  }
}

/** The tab a request names (Docs defaults to the first tab). */
function targetTab(tabs: FakeTab[], r: Req): FakeTab {
  const v = Object.values(r)[0] as Record<string, unknown>;
  const ids: (string | undefined)[] = [
    (v?.location as { tabId?: string })?.tabId,
    (v?.endOfSegmentLocation as { tabId?: string })?.tabId,
    (v?.range as { tabId?: string })?.tabId,
    (v?.tabsCriteria as { tabIds?: string[] })?.tabIds?.[0],
    (v?.tabProperties as { tabId?: string })?.tabId,
  ];
  const id = ids.find(Boolean);
  if (!id) {
    const name = (v?.name ?? v?.namedRangeName) as string | undefined;
    const byRange = name ? tabs.find((t) => t.doc.tabs![0].documentTab!.namedRanges?.[name]) : undefined;
    return byRange ?? tabs[0];
  }
  const tab = tabs.find((t) => t.tabId === id);
  if (!tab) throw new Error(`no tab ${id}`);
  return tab;
}

/** Every `tabId` in a request rewritten to docsim's single tab. */
function onSimTab(r: Req): Req {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === "tabId") out[k] = TAB;
        else if (k === "tabIds") out[k] = [TAB];
        else out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(r) as Req;
}

function endIndexOf(doc: Doc): number {
  const content = doc.tabs![0].documentTab!.body!.content ?? [];
  return (content.at(-1)?.endIndex ?? 2) - 1;
}

function applyOne(tabs: FakeTab[], r: Req): Record<string, unknown> {
  if (r.addDocumentTab) {
    const tabId = `t.${randomBytes(6).toString("hex")}`;
    const title = r.addDocumentTab.tabProperties?.title ?? `Flik ${tabs.length + 1}`;
    tabs.push({ tabId, title, doc: docOf([paraEl("")]) });
    return { addDocumentTab: { tabProperties: { tabId, title, index: tabs.length - 1 } } };
  }
  const tab = targetTab(tabs, r);
  if (r.updateDocumentTabProperties) {
    const title = r.updateDocumentTabProperties.tabProperties?.title;
    if (title) tab.title = title;
    return {};
  }
  if (r.insertText?.endOfSegmentLocation) {
    apply(tab.doc, [{ insertText: { text: r.insertText.text, location: { tabId: TAB, index: endIndexOf(tab.doc) } } }]);
    return {};
  }
  if (r.replaceNamedRangeContent) {
    const name = r.replaceNamedRangeContent.namedRangeName;
    const group = name ? tab.doc.tabs![0].documentTab!.namedRanges?.[name] : undefined;
    const ranges = (group?.namedRanges ?? []).flatMap((nr) => nr.ranges ?? []);
    if (!name || ranges.length === 0) throw new Error(`named range ${name} not found`);
    const start = Math.min(...ranges.map((x) => x.startIndex ?? 0));
    const text = r.replaceNamedRangeContent.text ?? "";
    const parts = ranges.filter((x) => (x.endIndex ?? 0) > (x.startIndex ?? 0)).sort((a, b) => (b.startIndex ?? 0) - (a.startIndex ?? 0));
    for (const p of parts) apply(tab.doc, [{ deleteContentRange: { range: { tabId: TAB, startIndex: p.startIndex, endIndex: p.endIndex } } }]);
    const named = (tab.doc.tabs![0].documentTab!.namedRanges ??= {});
    const id = group?.namedRanges?.[0]?.namedRangeId ?? `id-${name}`;
    if (text) apply(tab.doc, [{ insertText: { text, location: { tabId: TAB, index: start } } }]);
    named[name] = { name, namedRanges: [{ name, namedRangeId: id, ranges: [{ tabId: TAB, startIndex: start, endIndex: start + text.length }] }] };
    return {};
  }
  apply(tab.doc, [onSimTab(r)]);
  return r.createNamedRange ? { createNamedRange: { namedRangeId: `id-${r.createNamedRange.name}` } } : {};
}

// ---------------------------------------------------------------------------------------------
// Drive `q`: and / or / not / parentheses over the terms the app sends.

type Pred = (f: FakeFile, user: string) => boolean;

export function parseQuery(q: string): Pred {
  const tokens = q.match(/'(?:[^'\\]|\\.)*'|\(|\)|!=|<=|>=|[=<>]|[A-Za-z_]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  const str = (t: string) => t.slice(1, -1).replace(/\\(.)/g, "$1");

  const term = (): Pred => {
    const t = take();
    if (t === "(") {
      const inner = or();
      take(); // )
      return inner;
    }
    if (t === "not") {
      const inner = term();
      return (f, u) => !inner(f, u);
    }
    if (t === "sharedWithMe") return (f, u) => f.owner !== u;
    if (t.startsWith("'")) {
      const value = str(t);
      take(); // in
      const field = take();
      if (field === "parents") return (f) => f.parents.includes(value);
      if (field === "owners") return (f, u) => (value === "me" ? f.owner === u : f.owner === value);
      throw new Error(`unsupported q: in ${field}`);
    }
    const field = t;
    const op = take();
    const raw = take();
    if (field === "trashed") return (f) => f.trashed === (raw === "true");
    const value = str(raw);
    const get = (f: FakeFile): string => (field === "mimeType" ? f.mimeType : field === "name" ? f.name : field === "modifiedTime" ? f.modifiedTime : field === "createdTime" ? f.createdTime : "");
    if (op === "contains") return (f) => get(f).toLowerCase().includes(value.toLowerCase());
    if (op === "=") return (f) => get(f) === value;
    if (op === "!=") return (f) => get(f) !== value;
    if (op === ">") return (f) => get(f) > value;
    if (op === "<") return (f) => get(f) < value;
    throw new Error(`unsupported q op ${op}`);
  };
  const and = (): Pred => {
    let left = term();
    while (peek() === "and") {
      take();
      const right = term();
      const l = left;
      left = (f, u) => l(f, u) && right(f, u);
    }
    return left;
  };
  function or(): Pred {
    let left = and();
    while (peek() === "or") {
      take();
      const right = and();
      const l = left;
      left = (f, u) => l(f, u) || right(f, u);
    }
    return left;
  }
  if (!q.trim()) return () => true;
  return or();
}

// ---------------------------------------------------------------------------------------------

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function send(res: ServerResponse, status: number, json: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(json));
}

function sendRaw(res: ServerResponse, body: string | Buffer, type: string): void {
  res.writeHead(200, { "content-type": type });
  res.end(body);
}
