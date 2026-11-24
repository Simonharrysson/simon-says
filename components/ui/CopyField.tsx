"use client";

import { useEffect, useState } from "react";
import { Button } from "./Button";
import { IconCheck, IconCopy } from "./icons";

/** Read-only value with a copy button. Falls back to selecting the text when the clipboard is blocked. */
export function CopyField({ id, value, label }: { id: string; value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2400);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      const input = document.getElementById(id) as HTMLInputElement | null;
      input?.select();
      setState("manual");
    }
  }

  return (
    <div className="field">
      <label className="visually-hidden" htmlFor={id}>
        {label}
      </label>
      <div className="copy-field">
        <input
          id={id}
          className="input input--mono"
          value={value}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button variant="primary" onClick={copy} icon={state === "copied" ? <IconCheck /> : <IconCopy />}>
          {state === "copied" ? "Kopierad" : "Kopiera"}
        </Button>
      </div>
      <p className="hint" aria-live="polite">
        {state === "copied" && "Länken är kopierad."}
        {state === "manual" && "Kunde inte kopiera automatiskt. Länken är markerad, tryck ⌘C eller Ctrl+C."}
      </p>
    </div>
  );
}
