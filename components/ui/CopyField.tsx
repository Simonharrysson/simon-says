"use client";

import { useEffect, useState } from "react";
import { Button } from "./button";
import { hintClass } from "./Field";
import { IconCheck, IconCopy } from "./icons";
import { Input } from "./input";
import { Label } from "./label";

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
    <div className="flex flex-col gap-2">
      <Label className="sr-only" htmlFor={id}>
        {label}
      </Label>
      <div className="flex gap-2">
        <Input id={id} mono className="flex-1 text-ellipsis" value={value} readOnly onFocus={(event) => event.currentTarget.select()} />
        <Button variant="primary" onClick={copy} icon={state === "copied" ? <IconCheck /> : <IconCopy />}>
          {state === "copied" ? "Kopierad" : "Kopiera"}
        </Button>
      </div>
      <p className={hintClass} aria-live="polite">
        {state === "copied" && "Länken är kopierad."}
        {state === "manual" && "Kunde inte kopiera automatiskt. Länken är markerad, tryck ⌘C eller Ctrl+C."}
      </p>
    </div>
  );
}
