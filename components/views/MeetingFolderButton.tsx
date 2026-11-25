"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PickerError, usePicker } from "@/components/google/Picker";
import { Button } from "@/components/ui/Button";

/** Admins: pick the förening's meeting folder in the Google Picker (POST /api/orgs/<id>/meeting-folder). */
export function MeetingFolderButton({ orgId, hasFolder }: { orgId: string; hasFolder: boolean }) {
  const picker = usePicker();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const pick = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const picked = await picker.open({ mode: "folder", title: "Välj mötesmappen" });
      if (!picked?.[0]) return;
      const res = await fetch(`/api/orgs/${orgId}/meeting-folder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderId: picked[0].id }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { message?: string } | null;
        setMessage(json?.message ?? "Mötesmappen kunde inte sparas. Försök igen.");
        return;
      }
      setMessage("Mötesmappen är sparad.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof PickerError ? err.message : "Google-väljaren kunde inte öppnas. Försök igen.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack stack--2">
      <div>
        <Button variant="secondary" loading={busy} onClick={() => void pick()}>
          {hasFolder ? "Byt mötesmapp" : "Välj mötesmapp"}
        </Button>
      </div>
      <p className="hint" aria-live="polite">
        {message ?? ""}
      </p>
    </div>
  );
}
