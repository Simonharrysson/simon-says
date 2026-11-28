"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { browserClipboard, COPIED_MS, copyText, type CopyState } from "@/lib/ui/copy";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { IconCopy } from "./icons";

/**
 * A value to copy (an address, a command, a config) in a tinted code field with "Kopiera", which
 * turns into "Kopierad ✓" for a moment (the tick draws itself). No frame: inside a card it is a
 * tinted area, never a box in a box. The value is selectable (one click selects it all), so a
 * blocked clipboard still leaves an easy manual copy.
 */
export function CopyCode({ value, label, block = false }: { value: string; label: string; block?: boolean }) {
  const t = useTranslations("common");
  const [state, setState] = useState<CopyState>("idle");
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state, round]);

  async function copy() {
    const result = await copyText(value, browserClipboard());
    setState(result);
    setRound((r) => r + 1);
  }

  const copied = state === "copied";
  return (
    <div className="flex flex-col gap-1">
      {/* Narrow (a phone, the side panel): the button drops under the value instead of breaking it. */}
      <div className="flex flex-wrap items-start justify-end gap-x-2 rounded-md bg-sunk py-1 pr-1 pl-3">
        <code
          aria-label={label}
          // A block can scroll sideways: reachable by keyboard.
          tabIndex={block ? 0 : undefined}
          className={cn(
            "min-w-[min(100%,42ch)] flex-1 py-2 font-mono text-xs leading-relaxed text-ink select-all",
            block ? "min-w-0 overflow-x-auto whitespace-pre rounded-sm focus-visible:outline-2 focus-visible:outline-focus" : "wrap-anywhere",
          )}
        >
          {value}
        </code>
        <Button
          variant="ghost"
          size="sm"
          onClick={copy}
          className="mt-0.5 text-ink hover:bg-surface"
          icon={copied ? <DrawnCheck key={round} /> : <IconCopy size={16} />}
        >
          {/* Both labels share one cell, so the button keeps its width. */}
          <span className="grid">
            <span className={cn("col-start-1 row-start-1", copied && "invisible")}>{t("copy")}</span>
            <span className={cn("col-start-1 row-start-1 text-green", !copied && "invisible")} aria-hidden={!copied}>
              {t("copied")}
            </span>
          </span>
        </Button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? t("copiedToClipboard") : ""}
      </span>
      {state === "failed" && (
        <p className="text-sm text-ink-2" role="alert">
          {t("copyFailed")}
        </p>
      )}
    </div>
  );
}

/** The tick, drawn on (stroke-dashoffset); instant under reduced motion. */
function DrawnCheck() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-green">
      <path d="M5 12.5l4.5 4.5L19 7.5" strokeDasharray={24} className="animate-check-draw" />
    </svg>
  );
}
