// Konto's collapsible sections (components/views/AccountSection.tsx): which ones are open.
// Every section starts closed. One opens when the user opened it before (localStorage, this
// browser, per account), when a link points at it (#ai), or when the server has something to
// show in it (a result banner: ?kalender=ok, ?fel=sprak). A toggle in this visit wins over all of
// that and is remembered. Pure, so the rules are unit-tested (sections.test.ts) and the same rules
// run in the pre-paint script below.

export const SECTION_IDS = ["sprak", "mejl", "kalender", "ai", "foreningar", "integritet"] as const;
export type SectionId = (typeof SECTION_IDS)[number];
export type Stored = Partial<Record<SectionId, boolean>>;

export const isSectionId = (v: unknown): v is SectionId => typeof v === "string" && (SECTION_IDS as readonly string[]).includes(v);

/** One key per account, so two people sharing a browser don't share their open sections. */
export const storageKey = (userId: string) => `ss.konto.sektioner.${userId}`;

/** What localStorage held: anything malformed reads as "nothing remembered". */
export function parseStored(raw: string | null | undefined): Stored {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Stored = {};
    for (const [k, open] of Object.entries(v)) if (isSectionId(k) && typeof open === "boolean") out[k] = open;
    return out;
  } catch {
    return {};
  }
}

/** `#ai` → "ai"; anything else → null. */
export function hashSection(hash: string | null | undefined): SectionId | null {
  if (!hash) return null;
  let id = hash.replace(/^#/, "");
  try {
    id = decodeURIComponent(id);
  } catch {
    return null;
  }
  return isSectionId(id) ? id : null;
}

export interface OpenInputs {
  /** Toggled in this visit (wins). */
  override?: boolean;
  /** The URL's #section. */
  hash: SectionId | null;
  /** Opened by the server (a result to show). */
  forced: readonly SectionId[];
  stored: Stored;
}

export function isOpen(id: SectionId, { override, hash, forced, stored }: OpenInputs): boolean {
  if (override !== undefined) return override;
  if (hash === id || forced.includes(id)) return true;
  return stored[id] === true;
}

/** Remembers a toggle. Never throws: a blocked or full storage just doesn't remember. */
export function remember(storage: Pick<Storage, "getItem" | "setItem"> | null | undefined, key: string, id: SectionId, open: boolean): void {
  if (!storage) return;
  try {
    const next = { ...parseStored(storage.getItem(key)), [id]: open };
    storage.setItem(key, JSON.stringify(next));
  } catch {
    // Private mode, blocked site data or quota: the page works the same, it just forgets.
  }
}

/** localStorage, or null where reading it throws (blocked site data) or there is none (server). */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredRaw(key: string): string | null {
  try {
    return safeLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Runs in the server HTML right after the sections, before the first paint: opens the sections
 * the rules above open (stored, #hash, forced), so a remembered section is open from the first
 * frame and nothing below it moves after hydration (CLS 0). Same rules as `isOpen` (no override
 * yet). Only touches attributes the sections render with suppressHydrationWarning.
 */
export function preOpenScript(key: string, forced: readonly SectionId[]): string {
  const ids = JSON.stringify(SECTION_IDS);
  return `(function(k,f,ids){try{var s={};try{s=JSON.parse(localStorage.getItem(k)||"{}")||{}}catch(e){}var h="";try{h=decodeURIComponent(location.hash.slice(1))}catch(e){}ids.forEach(function(id){var el=document.getElementById(id);if(!el||!el.hasAttribute("data-account-section"))return;if(h===id||f.indexOf(id)>=0||s[id]===true){el.setAttribute("data-state","open");var b=el.querySelector("[data-section-trigger]");if(b){b.setAttribute("aria-expanded","true");b.setAttribute("data-state","open")}}})}catch(e){}})(${JSON.stringify(key)},${JSON.stringify(forced)},${ids})`.replace(/</g, "\\u003c");
}
