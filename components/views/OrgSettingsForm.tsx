"use client";

import { useEffect, useState } from "react";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { Check, Field } from "@/components/ui/Field";
import { IconCheck } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";

/** Org settings. The server action only revalidates, so "Sparat" is confirmed here. */
export function OrgSettingsForm({
  org,
  updateOrg,
  nameError,
}: {
  org: { id: string; name: string; share_transcript: boolean; show_on_status: boolean };
  updateOrg: FormAction;
  nameError?: string;
}) {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [saved]);

  return (
    <form
      className="flex max-w-[40rem] flex-col gap-6"
      action={async (form) => {
        setSaved(false);
        await updateOrg(form);
        setSaved(true);
      }}
      onChange={() => setSaved(false)}
>
      <input type="hidden" name="orgId" value={org.id} />
      <Field id="settings-name" name="name" label="Namn" defaultValue={org.name} required maxLength={100} error={nameError} />
      {/* Keyed on the saved value: React resets the form after the action, and a Radix checkbox
          resets to the value it mounted with; the key remounts it on the server's new value. */}
      <Check key={`share-${org.share_transcript}`} id="settings-share" name="share_transcript" defaultChecked={org.share_transcript} onCheckedChange={() => setSaved(false)} title="Dela transkriptionen i dokumentet">
        Hela transkriptionen hamnar i en egen flik i mötesdokumentet. Stäng av om ni bara vill dela anteckningarna.
      </Check>
      <Check key={`status-${org.show_on_status}`} id="settings-status" name="show_on_status" defaultChecked={org.show_on_status} onCheckedChange={() => setSaved(false)} title="Visa namnet på statussidan">
        Statussidan är offentlig. Utan kryss står det bara &quot;en förening&quot; när ni har möte.
      </Check>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="primary" pendingLabel="Sparar…">
          Spara ändringar
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
