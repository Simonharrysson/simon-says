/**
 * Task 2 early check: the real Google Doc model, on a real signed-in account.
 *
 *   npm run check-google -- <userId|email> <stage> [args]
 *
 * Stages (run in this order; Simon acts in the Doc between some of them):
 *   token                       stored refresh token works; prints Google's granted scopes
 *   setup                       new Doc, tab "Transkript", 3 paragraphs + 3 named ranges in notes tab
 *   inspect                     print both tabs and every named range (run after Simon edits)
 *   replace [name] [text]       replaceNamedRangeContent on one range; check neighbours untouched
 *   stale                       batchUpdate with a stale requiredRevisionId; expect 400
 *   append [seconds]            append a line to the transcript tab every 2 s (Simon types there)
 *   typing [seconds] [interval] read→write ticks on range ss-2 with the revision guard (Simon types)
 *   share <email>               share as writer with sendNotificationEmail=false
 *
 * Env: reads ~/simon-says-private/.env (override with SIMON_SAYS_ENV) and fetches the
 * service-role key with SUPABASE_ACCESS_TOKEN. Never prints secrets.
 * State (doc id, tab ids) lives in .check-google/state.json (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT_REF = "orvdeynkpfcujocrjgud";
const STATE_DIR = join(process.cwd(), ".check-google");
const STATE_FILE = join(STATE_DIR, "state.json");
const RANGES = ["ss-1", "ss-2", "ss-3"];

interface State {
  documentId: string;
  notesTabId: string;
  transcriptTabId: string;
  url: string;
}

function loadEnvFile(path: string): void {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

async function prepareEnv(): Promise<void> {
  loadEnvFile(process.env.SIMON_SAYS_ENV ?? join(homedir(), "simon-says-private", ".env"));
  process.env.SUPABASE_URL ??= `https://${PROJECT_REF}.supabase.co`;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const token = process.env.SUPABASE_ACCESS_TOKEN;
    if (!token) throw new Error("need SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ACCESS_TOKEN");
    const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`fetching api keys: HTTP ${res.status}`);
    const keys = (await res.json()) as { name: string; api_key: string }[];
    const service = keys.find((k) => k.name === "service_role")?.api_key;
    const anon = keys.find((k) => k.name === "anon")?.api_key;
    if (!service) throw new Error("no service_role key in the api-keys response");
    process.env.SUPABASE_SERVICE_ROLE_KEY = service;
    process.env.SUPABASE_ANON_KEY ??= anon;
  }
  // Required by lib/env but unused here.
  const unused: Record<string, string> = {
    SUPABASE_ANON_KEY: "unused-by-check-google",
    ELEVENLABS_API_KEY: "unused-by-check-google",
    ELEVENLABS_COMMIT_STRATEGY: "vad",
    ANTHROPIC_API_KEY: "unused-by-check-google",
    ALARM_EMAIL: "unused@example.com",
    CRON_SECRET: "unused-by-check-google",
    APP_URL: "http://localhost:3000",
  };
  for (const [k, v] of Object.entries(unused)) process.env[k] ??= v;
}

const readState = (): State => JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
const now = () => new Date().toISOString().slice(11, 19);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errInfo = (err: unknown) => {
  const e = err as { status?: number; code?: number; response?: { status?: number }; message?: string };
  return { status: e.status ?? e.response?.status ?? e.code, message: e.message };
};

async function main(): Promise<void> {
  const [userArg, stage, ...args] = process.argv.slice(2);
  if (!userArg || !stage) {
    console.error("usage: npm run check-google -- <userId|email> <stage> [args]  (see file header)");
    process.exit(2);
  }
  await prepareEnv();

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { getGoogleAuth } = await import("@/lib/google/client");
  const { fetchGrantedScope, hasDriveFile } = await import("@/lib/google/scopes");
  const g = await import("@/lib/google/docs");

  let userId = userArg;
  if (userArg.includes("@")) {
    const { data, error } = await supabaseAdmin().auth.admin.listUsers({ perPage: 1000 });
    if (error) throw error;
    const user = data.users.find((u) => u.email?.toLowerCase() === userArg.toLowerCase());
    if (!user) throw new Error(`no Supabase user with email ${userArg}`);
    userId = user.id;
  }
  console.log(`user ${userId}`);

  const auth = await getGoogleAuth(userId);
  const docs = g.docsApi(auth);
  const drive = g.driveApi(auth);
  const getDoc = async (documentId: string) =>
    (await docs.documents.get({ documentId, includeTabsContent: true })).data;
  const batch = (documentId: string, requests: unknown[], requiredRevisionId?: string) =>
    docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: requests as never,
        ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}),
      },
    });

  const printTab = (snap: ReturnType<typeof g.readTab>) => {
    console.log(`\n--- tab "${snap.title}" (${snap.tabId}) rev ${snap.revisionId}`);
    console.log(JSON.stringify(snap.text));
    for (const r of snap.ranges) {
      const parts = r.parts.map((p) => `[${p.startIndex},${p.endIndex}) ${JSON.stringify(p.text)}`).join(" + ");
      console.log(`  ${r.name} (${r.namedRangeId}): ${r.parts.length} part(s): ${parts}`);
    }
  };

  switch (stage) {
    case "token": {
      const { token } = await auth.getAccessToken();
      const scope = token ? await fetchGrantedScope(token) : null;
      console.log(`refresh token OK; granted scope: ${scope}; drive.file: ${scope ? hasDriveFile(scope) : false}`);
      break;
    }

    case "setup": {
      const title = `Simon Says testdokument ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      const created = (await docs.documents.create({ requestBody: { title } })).data;
      const documentId = created.documentId!;
      const first = (await getDoc(documentId)).tabs?.[0]?.tabProperties?.tabId;
      if (!first) throw new Error("new doc has no first tab");
      const added = await batch(documentId, [
        { addDocumentTab: { tabProperties: { title: "Transkript" } } },
        { updateDocumentTabProperties: { tabProperties: { tabId: first, title: "Anteckningar" }, fields: "title" } },
      ]);
      const transcriptTabId = added.data.replies?.[0]?.addDocumentTab?.tabProperties?.tabId;
      if (!transcriptTabId) throw new Error("addDocumentTab returned no tabId");
      await batch(
        documentId,
        g.paragraphsWithRanges(first, 1, [
          { name: "ss-1", text: "Punkt ett: budgeten för våren" },
          { name: "ss-2", text: "Punkt två: vem bokar lokalen" },
          { name: "ss-3", text: "Punkt tre: nästa möte" },
        ]),
      );
      const state: State = {
        documentId,
        notesTabId: first,
        transcriptTabId,
        url: `https://docs.google.com/document/d/${documentId}/edit`,
      };
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log(JSON.stringify(state, null, 2));
      const doc = await getDoc(documentId);
      printTab(g.readTab(doc, first));
      break;
    }

    case "inspect": {
      const s = readState();
      const doc = await getDoc(s.documentId);
      printTab(g.readTab(doc, s.notesTabId));
      printTab(g.readTab(doc, s.transcriptTabId));
      break;
    }

    case "replace": {
      const s = readState();
      const name = args[0] ?? "ss-2";
      const text = args[1] ?? `Ersatt av skriptet ${now()}`;
      const before = g.readTab(await getDoc(s.documentId), s.notesTabId);
      await batch(s.documentId, [g.replaceRange(s.notesTabId, name, text)]);
      const after = g.readTab(await getDoc(s.documentId), s.notesTabId);
      printTab(after);
      const textOf = (snap: typeof before, n: string) =>
        snap.ranges.filter((r) => r.name === n).map((r) => r.parts.map((p) => p.text).join("|")).join("/");
      for (const n of RANGES.filter((r) => r !== name)) {
        const same = textOf(before, n) === textOf(after, n);
        console.log(`neighbour ${n}: ${same ? "untouched" : `CHANGED ${JSON.stringify(textOf(before, n))} -> ${JSON.stringify(textOf(after, n))}`}`);
      }
      console.log(`target ${name}: ${JSON.stringify(textOf(after, name))} (still a named range: ${after.ranges.some((r) => r.name === name)})`);
      const outside = (snap: typeof before) => snap.text.split("\n").filter((l) => !snap.ranges.some((r) => r.parts.some((p) => p.text && l.includes(p.text))));
      console.log(`lines outside ranges unchanged: ${JSON.stringify(outside(before)) === JSON.stringify(outside(after))}`);
      break;
    }

    case "stale": {
      const s = readState();
      const staleRev = (await getDoc(s.documentId)).revisionId!;
      await batch(s.documentId, [g.appendToTab(s.transcriptTabId, `[${now()}] revision bump\n`)]);
      try {
        await batch(s.documentId, [g.replaceRange(s.notesTabId, "ss-3", "Ska inte skrivas")], staleRev);
        console.log("UNEXPECTED: write with stale requiredRevisionId succeeded");
      } catch (err) {
        console.log(`stale write rejected: ${JSON.stringify(errInfo(err))}; isRevisionConflict=${g.isRevisionConflict(err)}`);
      }
      break;
    }

    case "append": {
      const s = readState();
      const seconds = Number(args[0] ?? 60);
      let ok = 0;
      const errors: unknown[] = [];
      for (let i = 1, end = Date.now() + seconds * 1000; Date.now() < end; i++) {
        try {
          await batch(s.documentId, [g.appendToTab(s.transcriptTabId, `[${now()}] Talare ${(i % 2) + 1}: rad ${i}\n`)]);
          ok++;
        } catch (err) {
          errors.push(errInfo(err));
        }
        await sleep(2000);
      }
      console.log(`appends ok ${ok}, failed ${errors.length}${errors.length ? ` ${JSON.stringify(errors)}` : ""}`);
      printTab(g.readTab(await getDoc(s.documentId), s.transcriptTabId));
      break;
    }

    case "typing": {
      const s = readState();
      const seconds = Number(args[0] ?? 120);
      const interval = Number(args[1] ?? 10);
      const ticks: { tick: number; conflicts: number; ok: boolean; error?: unknown }[] = [];
      for (let tick = 1, end = Date.now() + seconds * 1000; Date.now() < end; tick++) {
        const started = Date.now();
        let conflicts = 0;
        try {
          const res = await g.writeWithRevisionGuard(
            async () => g.readTab(await getDoc(s.documentId), s.notesTabId),
            async (snap) => {
              try {
                return await batch(s.documentId, [g.replaceRange(s.notesTabId, "ss-2", `Punkt två (tick ${tick} ${now()})`)], snap.revisionId);
              } catch (err) {
                if (g.isRevisionConflict(err)) conflicts++;
                throw err;
              }
            },
          );
          ticks.push({ tick, conflicts: res.conflicts, ok: true });
        } catch (err) {
          ticks.push({ tick, conflicts, ok: false, error: errInfo(err) });
        }
        const t = ticks.at(-1)!;
        console.log(`[${now()}] tick ${tick}: ${t.ok ? "written" : "FAILED"} after ${t.conflicts} conflict(s)`);
        await sleep(Math.max(0, interval * 1000 - (Date.now() - started)));
      }
      const firstTry = ticks.filter((t) => t.ok && t.conflicts === 0).length;
      const retried = ticks.filter((t) => t.ok && t.conflicts > 0).length;
      const failed = ticks.filter((t) => !t.ok);
      const total = ticks.reduce((n, t) => n + t.conflicts, 0);
      console.log(
        `\nSUMMARY ticks=${ticks.length} firstTry=${firstTry} okAfterRetry=${retried} failedAfter4Retries=${failed.length} totalConflicts=${total} maxConflictsInOneTick=${Math.max(0, ...ticks.map((t) => t.conflicts))}`,
      );
      if (failed.length) console.log(JSON.stringify(failed));
      printTab(g.readTab(await getDoc(s.documentId), s.notesTabId));
      break;
    }

    case "share": {
      const s = readState();
      const email = args[0];
      if (!email) throw new Error("share needs an email");
      const res = await drive.permissions.create({
        fileId: s.documentId,
        sendNotificationEmail: false,
        requestBody: { type: "user", role: "writer", emailAddress: email },
        fields: "id,role,emailAddress",
      });
      console.log(`shared: ${JSON.stringify(res.data)} at ${new Date().toISOString()} (sendNotificationEmail=false)`);
      break;
    }

    default:
      throw new Error(`unknown stage ${stage}`);
  }
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error(`${e.name}: ${e.message}`);
  process.exit(1);
});
