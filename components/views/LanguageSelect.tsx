"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

const LANGUAGES = [
  { value: "sv", label: "Svenska" },
  { value: "en", label: "English" },
] as const;

/**
 * Konto's language choice: two submit buttons (the chosen one pressed). A click saves at once,
 * like the mail switches, with no separate Save button; it is a plain form post, so it works without JS too.
 * "Sparar…" shows in a line that always takes its space.
 */
export function LanguageSelect({ labelId, current, savingLabel }: { labelId: string; current: string; savingLabel: string }) {
  const { pending, data } = useFormStatus();
  const chosen = pending ? ((data?.get("locale") as string | null) ?? current) : current;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div role="group" aria-labelledby={labelId} aria-describedby={`${labelId}-status`} className="inline-flex gap-1 rounded-md bg-sunk p-1">
        {LANGUAGES.map((l) => (
          <Button
            key={l.value}
            type="submit"
            name="locale"
            value={l.value}
            lang={l.value}
            size="sm"
            variant={chosen === l.value ? "primary" : "ghost"}
            aria-pressed={chosen === l.value}
            loading={pending && chosen === l.value}
            disabled={pending && chosen !== l.value}
          >
            {l.label}
          </Button>
        ))}
      </div>
      <span id={`${labelId}-status`} className="min-h-5 text-sm text-ink-2" role="status" aria-live="polite">
        {pending ? savingLabel : ""}
      </span>
    </div>
  );
}
