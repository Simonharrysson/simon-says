import { docs, type docs_v1 } from "@googleapis/docs";
import { drive } from "@googleapis/drive";
import type { OAuth2Client } from "google-auth-library";
import { e2eGoogleRoot } from "@/lib/e2e/guard";

// Thin helpers over the Docs/Drive APIs. Every request names its tab (tabId / tabsCriteria).
// Indices are UTF-16 code units, the same unit as JS string length.

export type DocsRequest = docs_v1.Schema$Request;

// The e2e test mode points both at the fake Google server (lib/e2e/guard.ts); otherwise Google.
const root = () => {
  const rootUrl = e2eGoogleRoot();
  return rootUrl ? { rootUrl } : {};
};
export const docsApi = (auth: OAuth2Client) => docs({ version: "v1", auth, ...root() });
export const driveApi = (auth: OAuth2Client) => drive({ version: "v3", auth, ...root() });

/**
 * Shared drives ("Delade enheter"): on every Drive call that names a file (get, create, update,
 * permissions), or Drive answers 404 for anything in a shared drive.
 */
export const ALL_DRIVES = { supportsAllDrives: true } as const;
/** A files.list across My Drive and shared drives. */
export const ALL_DRIVES_LIST = { supportsAllDrives: true, includeItemsFromAllDrives: true } as const;

/** Insert items as consecutive paragraphs at `index`, with one named range per item (text only, no newline). */
export function paragraphsWithRanges(
  tabId: string,
  index: number,
  items: { name: string; text: string }[],
): DocsRequest[] {
  for (const item of items) {
    if (item.text.includes("\n")) throw new Error(`item ${item.name} contains a newline`);
  }
  const requests: DocsRequest[] = [
    { insertText: { text: items.map((i) => i.text).join("\n"), location: { index, tabId } } },
  ];
  let offset = index;
  for (const item of items) {
    requests.push({
      createNamedRange: {
        name: item.name,
        range: { tabId, startIndex: offset, endIndex: offset + item.text.length },
      },
    });
    offset += item.text.length + 1;
  }
  return requests;
}

export function replaceRange(tabId: string, name: string, text: string): DocsRequest {
  return { replaceNamedRangeContent: { namedRangeName: name, text, tabsCriteria: { tabIds: [tabId] } } };
}

export function appendToTab(tabId: string, text: string): DocsRequest {
  return { insertText: { text, endOfSegmentLocation: { tabId } } };
}

export interface RangeSnapshot {
  name: string;
  namedRangeId: string;
  /** A named range can end up as several discontinuous parts (e.g. after a split). */
  parts: { startIndex: number; endIndex: number; text: string }[];
}

export interface TabSnapshot {
  revisionId: string;
  tabId: string;
  title: string;
  /** The tab's body text, starting at body index `startIndex`. */
  text: string;
  startIndex: number;
  ranges: RangeSnapshot[];
}

function findTab(tabs: docs_v1.Schema$Tab[] | undefined, tabId: string): docs_v1.Schema$Tab | undefined {
  for (const tab of tabs ?? []) {
    if (tab.tabProperties?.tabId === tabId) return tab;
    const child = findTab(tab.childTabs, tabId);
    if (child) return child;
  }
  return undefined;
}

/** Text and named ranges of one tab, from a `documents.get` with includeTabsContent=true. */
export function readTab(doc: docs_v1.Schema$Document, tabId: string): TabSnapshot {
  const tab = findTab(doc.tabs, tabId);
  if (!tab?.documentTab) throw new Error(`tab ${tabId} not found (was includeTabsContent set?)`);

  const chars = new Map<number, string>();
  for (const el of tab.documentTab.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      const content = pe.textRun?.content;
      if (content == null || pe.startIndex == null) continue;
      for (let i = 0; i < content.length; i++) chars.set(pe.startIndex + i, content[i]);
    }
  }
  const indices = [...chars.keys()];
  const startIndex = indices.length ? Math.min(...indices) : 1;
  const endIndex = indices.length ? Math.max(...indices) + 1 : 1;
  const slice = (from: number, to: number) => {
    let s = "";
    for (let i = from; i < to; i++) s += chars.get(i) ?? "";
    return s;
  };

  const ranges: RangeSnapshot[] = [];
  for (const group of Object.values(tab.documentTab.namedRanges ?? {})) {
    for (const nr of group.namedRanges ?? []) {
      ranges.push({
        name: nr.name ?? "",
        namedRangeId: nr.namedRangeId ?? "",
        parts: (nr.ranges ?? []).map((r) => ({
          startIndex: r.startIndex ?? 0,
          endIndex: r.endIndex ?? 0,
          text: slice(r.startIndex ?? 0, r.endIndex ?? 0),
        })),
      });
    }
  }
  ranges.sort((a, b) => (a.parts[0]?.startIndex ?? 0) - (b.parts[0]?.startIndex ?? 0));

  return {
    revisionId: doc.revisionId ?? "",
    tabId,
    title: tab.tabProperties?.title ?? "",
    text: slice(startIndex, endIndex),
    startIndex,
    ranges,
  };
}

/** True for the 400 Docs returns when `requiredRevisionId` is no longer the latest revision. */
export function isRevisionConflict(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown }; message?: unknown };
  const status = e?.status ?? e?.response?.status ?? e?.code;
  return Number(status) === 400 && typeof e?.message === "string" && /revision/i.test(e.message);
}

export interface GuardResult<T> {
  value: T;
  /** Number of revision conflicts before the write went through. */
  conflicts: number;
}

/** Random wait before a read→write retry: 150–600 ms (Task 2: immediate retries lost to continuous typing). */
export function retryDelayMs(random: () => number = Math.random): number {
  return 150 + Math.floor(random() * 451);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface GuardOptions {
  maxRetries?: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * read → write with the read's revision; on a revision conflict, wait `retryDelayMs()` and
 * repeat read → write up to `maxRetries` (default 4) more times. Other errors, and the
 * conflict after the last retry, are thrown.
 */
export async function writeWithRevisionGuard<S, T>(
  read: () => Promise<S>,
  write: (snapshot: S) => Promise<T>,
  options: GuardOptions = {},
): Promise<GuardResult<T>> {
  const { maxRetries = 4, sleep: wait = sleep, random = Math.random } = options;
  for (let conflicts = 0; ; conflicts++) {
    if (conflicts > 0) await wait(retryDelayMs(random));
    const snapshot = await read();
    try {
      return { value: await write(snapshot), conflicts };
    } catch (err) {
      if (!isRevisionConflict(err) || conflicts >= maxRetries) throw err;
    }
  }
}
