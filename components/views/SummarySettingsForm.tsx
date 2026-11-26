"use client";

import { useEffect, useState } from "react";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { Checkbox } from "@/components/ui/checkbox";
import { hintClass } from "@/components/ui/Field";
import { IconCheck } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { SummaryMode } from "@/lib/db/types";
import { cn } from "@/lib/utils";

export interface SummaryPersonOption {
  id: string;
  name: string;
  role?: string | null;
  /** Has an address (their own e-mail, or a linked member account). */
  hasEmail: boolean;
  selected: boolean;
}

const MODES: { mode: SummaryMode; title: string; hint: string }[] = [
  { mode: "missed", title: "Till de som missade mötet", hint: "Alla i personlistan med e-post som inte var med. Förvalt." },
  { mode: "all", title: "Till alla", hint: "Alla i personlistan med e-post, också de som var med." },
  { mode: "selected", title: "Till utvalda personer", hint: "Bara de du kryssar i nedan." },
  { mode: "off", title: "Av", hint: "Inga sammanfattningar skickas." },
];

/**
 * Inställningar → "Sammanfattning efter mötet" (0037, admins). After a meeting Simon Says mails
 * its decisions and tasks; this picks who gets them. "Sparat" is confirmed here, as in OrgSettingsForm.
 */
export function SummarySettingsForm({
  orgId,
  mode: savedMode,
  people,
  action,
}: {
  orgId: string;
  mode: SummaryMode;
  people: SummaryPersonOption[];
  action: FormAction;
}) {
  const [mode, setMode] = useState<SummaryMode>(savedMode);
  const [saved, setSaved] = useState(false);
  useEffect(() => setMode(savedMode), [savedMode]);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [saved]);
  const withEmail = people.filter((p) => p.hasEmail).length;

  return (
    <form
      className="flex max-w-[40rem] flex-col gap-5"
      action={async (form) => {
        setSaved(false);
        await action(form);
        setSaved(true);
      }}
      onChange={() => setSaved(false)}
    >
      <input type="hidden" name="orgId" value={orgId} />
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-medium">Sammanfattning efter mötet</legend>
        <p className="mb-2 text-sm text-ink-2">
          När ett möte är klart mejlar Simon Says besluten och uppgifterna. Var och en ser sina egna uppgifter först och kan
          tacka nej i mejlet eller under Konto. Testmöten skickas aldrig.
        </p>
        {MODES.map((o) => {
          const checked = mode === o.mode;
          return (
            <label
              key={o.mode}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border bg-surface p-4 transition-colors duration-120",
                checked ? "border-ink" : "border-line hover:border-control",
              )}
            >
              <input
                type="radio"
                name="summary_mode"
                value={o.mode}
                checked={checked}
                onChange={() => setMode(o.mode)}
                className="mt-1 size-4 accent-[var(--ink)]"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{o.title}</span>
                <span className={hintClass}>{o.hint}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {mode === "selected" ? (
        <fieldset className="flex flex-col">
          <legend className="mb-2 text-sm font-medium">Vilka ska få sammanfattningen?</legend>
          {people.length === 0 ? (
            <p className="text-sm text-ink-3">Personlistan är tom. Lägg till personer under Personer.</p>
          ) : (
            <ul className="flex flex-col rounded-lg border border-line bg-surface">
              {people.map((p) => {
                const id = `summary-person-${p.id}`;
                const note = !p.hasEmail ? "Ingen e-postadress" : null;
                return (
                  <li key={p.id} className="border-t border-line first:border-t-0">
                    <label htmlFor={id} className={cn("flex min-h-11 items-center gap-3 px-4 py-2", p.hasEmail ? "cursor-pointer" : "cursor-not-allowed")}>
                      <Checkbox
                        // Remount on the saved value: a Radix checkbox resets to the value it mounted with.
                        key={`${p.id}-${p.selected}`}
                        id={id}
                        name="summary_person"
                        value={p.id}
                        defaultChecked={p.selected}
                        disabled={!p.hasEmail}
                        onCheckedChange={() => setSaved(false)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium wrap-anywhere">
                          {p.name}
                          {p.role && <span className="font-normal text-ink-3"> · {p.role}</span>}
                        </span>
                        {note && <span className={hintClass}>{note}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      ) : (
        mode !== "off" && (
          <p className="text-sm text-ink-3">
            {withEmail === 0
              ? "Ingen i personlistan har en e-postadress än. Lägg till adresser i Kom igång → Styrelsen."
              : `${withEmail} ${withEmail === 1 ? "person" : "personer"} i personlistan har en e-postadress.`}
          </p>
        )
      )}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="primary" pendingLabel="Sparar…">
          Spara
        </SubmitButton>
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-green" role="status" aria-live="polite">
          {saved && (
            <>
              <IconCheck size={18} /> Sparat
            </>
          )}
        </span>
      </div>
    </form>
  );
}
