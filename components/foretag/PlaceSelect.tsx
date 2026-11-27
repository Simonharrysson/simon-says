"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";

/**
 * "Flytta till …" (Personer & grupper, 0050): a select that saves as soon as it changes (a real
 * form post, so it also works before hydration via the hidden button). While saving, a spinner
 * sits in a fixed slot next to it, so nothing shifts.
 */
export function PlaceSelect({
  action,
  hidden,
  value,
  options,
  label,
  savingLabel,
  name = "groupId",
}: {
  action: FormAction;
  hidden: Record<string, string>;
  value: string;
  options: { value: string; label: string }[];
  /** The select's accessible name ("Flytta Anna till"). */
  label: string;
  savingLabel: string;
  /** The posted field (0062's "Rapporterar till" posts `to`). */
  name?: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [current, setCurrent] = useState(value);
  return (
    <form ref={form} action={action} className="flex items-center gap-2">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <NativeSelect
        name={name}
        aria-label={label}
        value={current}
        className="w-[min(14rem,52vw)]"
        onChange={(e) => {
          setCurrent(e.target.value);
          form.current?.requestSubmit();
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
      <Pending label={savingLabel} />
      <noscript>
        <button type="submit">OK</button>
      </noscript>
    </form>
  );
}

function Pending({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <span className="inline-flex size-5 flex-none items-center justify-center" aria-live="polite">
      {pending && (
        <>
          <Spinner className="size-4 text-ink-3" />
          <span className="sr-only">{label}</span>
        </>
      )}
    </span>
  );
}
