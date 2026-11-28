"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cardClass } from "@/components/ui/card";
import { IconChevronDown } from "@/components/ui/icons";
import {
  hashSection,
  isOpen,
  parseStored,
  preOpenScript,
  readStoredRaw,
  remember,
  safeLocalStorage,
  storageKey,
  type SectionId,
} from "@/lib/account/sections";
import { cn } from "@/lib/utils";

// Konto as collapsible sections (lib/account/sections.ts has the rules). Each section is a card
// whose header row is the toggle: the title, a short summary of the current state while closed,
// and a chevron. The content stays mounted (a form keeps what was typed) and closes on height
// (grid rows 0fr ↔ 1fr, the press spring, ≈ 390 ms; instant under reduced motion); while closed
// it is `visibility: hidden`, so nothing in it can be focused or read out.

interface Sections {
  open: (id: SectionId) => boolean;
  toggle: (id: SectionId, open: boolean) => void;
}

const SectionsContext = createContext<Sections | null>(null);
type LiveSummary = { text: string; on?: boolean };
const SummaryContext = createContext<((summary: LiveSummary) => void) | null>(null);

/**
 * Lets content inside a section keep the header's summary current (e.g. "4 av 6 på" after a
 * switch). Outside a section (the /mejl page) it does nothing.
 */
export function useSectionSummary(text: string, on?: boolean) {
  const set = useContext(SummaryContext);
  useEffect(() => {
    set?.({ text, on });
  }, [set, text, on]);
}

const noop = () => () => {};
function subscribeUrlAndStorage(callback: () => void) {
  window.addEventListener("hashchange", callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener("hashchange", callback);
    window.removeEventListener("storage", callback);
  };
}

/**
 * The open/closed state of every section on the page. The server renders all of them closed,
 * except `forced` (a result banner to show); the script after them opens the remembered and
 * linked ones before the first paint, and hydration then agrees with it.
 */
export function AccountSections({ userId, forced = [], children }: { userId: string; forced?: SectionId[]; children: ReactNode }) {
  const key = storageKey(userId);
  // "#hash\nstored" as one string, so the snapshot is stable between reads.
  const snapshot = useSyncExternalStore(
    subscribeUrlAndStorage,
    () => `${window.location.hash}\n${readStoredRaw(key) ?? ""}`,
    () => "\n",
  );
  const hydrating = useSyncExternalStore(noop, () => false, () => true);
  const [overrides, setOverrides] = useState<Partial<Record<SectionId, boolean>>>({});

  const [rawHash, rawStored] = [snapshot.slice(0, snapshot.indexOf("\n")), snapshot.slice(snapshot.indexOf("\n") + 1)];
  const hash = hashSection(rawHash);
  const stored = useMemo(() => parseStored(rawStored), [rawStored]);

  // A link to a section opens it (even one closed earlier in this visit), and it stays open
  // when the link changes, until the user closes it. Not remembered: only a click is.
  useEffect(() => {
    if (hash) setOverrides((o) => (o[hash] === true ? o : { ...o, [hash]: true }));
  }, [hash]);

  const forcedKey = forced.join(",");
  const value = useMemo<Sections>(() => {
    const forcedIds = forcedKey ? (forcedKey.split(",") as SectionId[]) : [];
    return {
      open: (id) => isOpen(id, { override: overrides[id], hash, forced: forcedIds, stored }),
      toggle: (id, open) => {
        setOverrides((o) => ({ ...o, [id]: open }));
        remember(safeLocalStorage(), key, id, open);
      },
    };
  }, [overrides, hash, forcedKey, stored, key]);

  return (
    <SectionsContext.Provider value={value}>
      {children}
      {/* Only in the server HTML (hydration keeps it, a client render never makes it): a script
          rendered on the client would not run anyway. */}
      {hydrating && <script dangerouslySetInnerHTML={{ __html: preOpenScript(key, forced) }} />}
    </SectionsContext.Provider>
  );
}

export function AccountSection({
  id,
  title,
  summary,
  children,
}: {
  id: SectionId;
  title: ReactNode;
  /** The state in a few words, shown in the header while the section is closed. */
  summary?: ReactNode;
  children: ReactNode;
}) {
  const sections = useContext(SectionsContext);
  const [live, setLive] = useState<LiveSummary | undefined>(undefined);
  const setSummary = useCallback((s: LiveSummary) => setLive(s), []);
  const titleId = `${id}-title`;
  const summaryId = useId();
  const open = sections?.open(id) ?? false;
  const shown = live ? live.on === undefined ? live.text : <SummaryStatus on={live.on}>{live.text}</SummaryStatus> : summary;

  return (
    <Collapsible open={open} onOpenChange={(next) => sections?.toggle(id, next)} asChild>
      <section
        id={id}
        data-account-section=""
        aria-labelledby={titleId}
        suppressHydrationWarning
        className={cn(cardClass, "group/section scroll-mt-24")}
      >
        <div className="relative flex min-h-16 items-center gap-3 px-6 py-4 max-md:px-4">
          <h2 id={titleId} className="shrink-0 text-lg tracking-[-0.02em]">
            <CollapsibleTrigger
              data-section-trigger=""
              suppressHydrationWarning
              aria-describedby={shown ? summaryId : undefined}
              className={cn(
                "cursor-pointer text-left text-ink outline-none",
                // The whole header row is the target; the focus ring follows the card's corners.
                "after:absolute after:inset-0 after:rounded-lg after:content-['']",
                "focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-focus",
              )}
            >
              {title}
            </CollapsibleTrigger>
          </h2>
          {shown !== undefined && (
            <span
              id={summaryId}
              className={cn(
                "ml-auto flex min-w-0 items-center gap-1.5 text-sm text-ink-3",
                "transition-opacity duration-200 ease-out group-data-[state=open]/section:opacity-0",
              )}
            >
              {typeof shown === "string" ? <span className="truncate">{shown}</span> : shown}
            </span>
          )}
          <IconChevronDown
            className={cn(
              "shrink-0 text-ink-3 transition-[rotate,color] duration-(--dur-press) [transition-timing-function:var(--ease-press)]",
              "group-hover/section:text-ink group-data-[state=open]/section:rotate-180",
              shown === undefined && "ml-auto",
            )}
          />
        </div>
        <CollapsibleContent
          forceMount
          suppressHydrationWarning
          className={cn(
            "grid grid-rows-[0fr] invisible group-data-[state=open]/section:visible group-data-[state=open]/section:grid-rows-[1fr]",
            "transition-[grid-template-rows,visibility] duration-(--dur-press) [transition-timing-function:var(--ease-press)]",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="px-6 pt-1 pb-6 max-md:px-4">
              <SummaryContext.Provider value={setSummary}>{children}</SummaryContext.Provider>
            </div>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** A summary with a status dot: green when something is on or connected. */
export function SummaryStatus({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-green" : "bg-rail")} />
      <span className="truncate">{children}</span>
    </>
  );
}
