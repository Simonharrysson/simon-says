"use client";

import { useFormStatus } from "react-dom";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Konto's language choice: saves as soon as it changes (like the mail switches), no Save button.
 * Inside the form whose server action saves it; "Sparar…" shows in a line that always takes its space.
 */
export function LanguageSelect({ id, defaultValue, savingLabel }: { id: string; defaultValue: string; savingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <div className="flex flex-wrap items-center gap-3" aria-busy={pending}>
      <NativeSelect
        id={id}
        name="locale"
        defaultValue={defaultValue}
        className="w-auto min-w-48"
        aria-describedby={`${id}-status`}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        <option value="sv" lang="sv">
          Svenska
        </option>
        <option value="en" lang="en">
          English
        </option>
      </NativeSelect>
      <span id={`${id}-status`} className="min-h-5 text-sm text-ink-2" role="status" aria-live="polite">
        {pending ? savingLabel : ""}
      </span>
    </div>
  );
}
