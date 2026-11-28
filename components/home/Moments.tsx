"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Dialog as DialogPrimitive } from "radix-ui";
import { transcriptMomentAction } from "@/app/(app)/orgs/moment-actions";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { MomentLine } from "@/lib/meetings/moments";
import { formatSaidAt } from "@/lib/notes/sources";
import { cn } from "@/lib/utils";

// "▶ 41:52" on a decision or task (0069) and the transcript sheet it opens: the lines around the
// moment, the source line(s) on a tint, scrolled into view. A side sheet from the right on wide
// screens, a bottom sheet on a phone. Text only: no audio is stored. The lines are read on click
// (the server re-checks who may read them) and kept for the visit, so a second open is instant.

type Load = { state: "loading" } | { state: "error" } | { state: "ok"; lines: MomentLine[] };

interface Open {
  itemId: string;
  saidAtMs: number;
}

const Ctx = createContext<((m: Open, from: HTMLElement) => void) | null>(null);

export function MomentsProvider({ meetingId, children }: { meetingId: string; children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [shown, setShown] = useState(false);
  const cache = useRef(new Map<string, Load>());
  // The ▶ that opened the sheet: focus goes back to it on close (there is no Dialog.Trigger).
  const from = useRef<HTMLElement | null>(null);
  const [, rerender] = useState(0);

  const fetchLines = useCallback(
    (itemId: string) => {
      cache.current.set(itemId, { state: "loading" });
      rerender((n) => n + 1);
      transcriptMomentAction(meetingId, itemId)
        .then((r) => cache.current.set(itemId, r.ok ? { state: "ok", lines: r.lines } : { state: "error" }))
        .catch(() => cache.current.set(itemId, { state: "error" }))
        .finally(() => rerender((n) => n + 1));
    },
    [meetingId],
  );

  const show = useCallback(
    (m: Open, el: HTMLElement) => {
      from.current = el;
      setOpen(m);
      setShown(true);
      const have = cache.current.get(m.itemId);
      if (!have || have.state === "error") fetchLines(m.itemId);
    },
    [fetchLines],
  );

  const load = open ? (cache.current.get(open.itemId) ?? { state: "loading" as const }) : null;
  return (
    <Ctx.Provider value={show}>
      {children}
      <DialogPrimitive.Root open={shown} onOpenChange={setShown}>
        <TranscriptSheet
          open={open}
          shown={shown}
          load={load}
          onRetry={() => open && fetchLines(open.itemId)}
          onCloseFocus={(e) => {
            if (!from.current?.isConnected) return;
            e.preventDefault();
            from.current.focus();
          }}
        />
      </DialogPrimitive.Root>
    </Ctx.Provider>
  );
}

/** The small "▶ 41:52" link. Renders nothing outside a MomentsProvider. */
export function MomentLink({ itemId, saidAtMs, className }: { itemId: string; saidAtMs: number; className?: string }) {
  const t = useTranslations("home");
  const show = useContext(Ctx);
  if (!show) return null;
  const time = formatSaidAt(saidAtMs);
  return (
    <button
      type="button"
      data-moment={itemId}
      onClick={(e) => show({ itemId, saidAtMs }, e.currentTarget)}
      aria-label={t("meeting.momentLink", { time })}
      aria-haspopup="dialog"
      className={cn(
        "inline-flex h-6 flex-none items-center gap-1 rounded-sm px-1.5 align-baseline text-sm font-medium tabular-nums text-ink-2",
        "transition-[background-color,color,scale] duration-150 ease-out hover:bg-sunk hover:text-ink active:scale-[0.96]",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
        className,
      )}
    >
      <span aria-hidden="true" className="text-[0.7em]">
        ▶
      </span>
      {time}
    </button>
  );
}

function TranscriptSheet({
  open,
  shown,
  load,
  onRetry,
  onCloseFocus,
}: {
  open: Open | null;
  shown: boolean;
  load: Load | null;
  onRetry: () => void;
  onCloseFocus: (e: Event) => void;
}) {
  const t = useTranslations("home");
  const list = useRef<HTMLOListElement>(null);
  const lines = load?.state === "ok" ? load.lines : null;

  // The source line in the middle of the view once the lines are there, on every open (instant: no scroll animation).
  const itemId = open?.itemId;
  useEffect(() => {
    if (!lines || !shown) return;
    const frame = requestAnimationFrame(() => list.current?.querySelector<HTMLElement>("[data-source]")?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [lines, shown, itemId]);

  const time = open ? formatSaidAt(open.saidAtMs) : "";
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <DialogPrimitive.Content
        data-testid="transcript-sheet"
        onCloseAutoFocus={onCloseFocus}
        className={cn(
          "fixed z-50 flex flex-col bg-surface text-ink shadow-lift outline-none",
          // Phone: a bottom sheet. Wide: a side sheet from the right.
          "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl",
          "sm:inset-x-auto sm:top-0 sm:right-0 sm:bottom-0 sm:max-h-none sm:w-[min(28rem,100vw)] sm:rounded-none sm:rounded-l-xl",
          "duration-300 ease-[var(--ease-spring)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=closed]:ease-out",
          "max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:slide-out-to-bottom sm:data-[state=open]:slide-in-from-right sm:data-[state=closed]:slide-out-to-right",
        )}
      >
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 flex-none rounded-full bg-line sm:hidden" />
        <div className="flex flex-none flex-col gap-1 px-6 pt-4 pb-3 max-[30rem]:px-4">
          <DialogPrimitive.Title className="text-lg font-semibold tabular-nums">{t("meeting.momentTitle", { time })}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-sm text-ink-2">{t("meeting.momentNoAudio")}</DialogPrimitive.Description>
        </div>
        <div
          // Focusable, so the transcript scrolls from the keyboard too.
          tabIndex={0}
          role="region"
          aria-label={t("meeting.momentTitle", { time })}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md px-3 pb-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink max-[30rem]:px-1"
          aria-live="polite"
          aria-busy={load?.state === "loading"}
        >
          {load?.state === "error" ? (
            <div className="flex flex-col items-start gap-3 px-3 py-2">
              <p className="text-sm text-ink-2">{t("meeting.momentError")}</p>
              <Button size="sm" onClick={onRetry}>
                {t("meeting.momentRetry")}
              </Button>
            </div>
          ) : lines ? (
            <ol ref={list} className="flex flex-col gap-1">
              {lines.map((l, i) => (
                <li
                  key={i}
                  {...(l.source ? { "data-source": "", "aria-current": "true" as const } : {})}
                  className={cn("flex flex-col gap-0.5 rounded-md px-3 py-2 animate-in fade-in-0 duration-200", l.source ? "bg-amber-wash" : "text-ink-2")}
                >
                  <span className="flex items-baseline gap-2 text-sm">
                    <span className="tabular-nums text-ink-3">{formatSaidAt(l.atMs)}</span>
                    <span className={cn("font-medium", l.source ? "text-ink" : "text-ink-2")}>{l.speaker ?? t("meeting.momentUnknownSpeaker")}</span>
                    {l.source && <span className="sr-only">{t("meeting.momentSourceLine")}</span>}
                  </span>
                  <span className={cn("wrap-anywhere", l.source && "text-ink")}>{l.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div role="status" className="flex flex-col gap-3 px-3 py-2" aria-label={t("meeting.momentLoading")}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className={cn("h-4", i % 2 ? "w-2/3" : "w-full")} />
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-none justify-end bg-board px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-[30rem]:px-4 sm:rounded-bl-xl">
          <DialogPrimitive.Close asChild>
            <Button>{t("meeting.momentClose")}</Button>
          </DialogPrimitive.Close>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
