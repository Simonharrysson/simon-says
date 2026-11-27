"use client";

import { useEffect, useState } from "react";
import { Button } from "./button";
import { IconCheck, IconCopy } from "./icons";

/**
 * Copies `value` and says so for a moment. The button keeps its width while the label swaps
 * (both labels share one grid cell), so nothing next to it moves.
 */
export function CopyButton({
  value,
  label,
  copiedLabel,
  copiedText,
  failedText,
}: {
  value: string;
  label: string;
  copiedLabel: string;
  /** Read out (and shown to sighted users as the label swap) after a copy. */
  copiedText: string;
  /** The clipboard was blocked. */
  failedText: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    // A failure stays until the next try; only "Kopierad" goes back by itself.
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 2400);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    setState("idle");
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button size="sm" onClick={copy} icon={state === "copied" ? <IconCheck size={16} /> : <IconCopy size={16} />}>
        <span className="grid">
          <span className={state === "copied" ? "invisible col-start-1 row-start-1" : "col-start-1 row-start-1"}>{label}</span>
          <span className={state === "copied" ? "col-start-1 row-start-1" : "invisible col-start-1 row-start-1"}>
            {copiedLabel}
          </span>
        </span>
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? copiedText : ""}
      </span>
      {state === "failed" && (
        <span className="text-xs text-ink-2" role="alert">
          {failedText}
        </span>
      )}
    </span>
  );
}
