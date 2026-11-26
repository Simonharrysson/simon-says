"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PickerError, usePicker } from "@/components/google/Picker";

/**
 * Admins: pick the förening's meeting folder in the Google Picker (POST /api/orgs/<id>/meeting-folder).
 * `pick` opens the Picker right away (user activation); `message` is the polite result line.
 */
export function useMeetingFolderPicker(orgId: string) {
  const t = useTranslations("common.picker");
  const picker = usePicker();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const pick = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const picked = await picker.open({ mode: "folder", title: t("folderTitle") });
      if (!picked?.[0]) return;
      const res = await fetch(`/api/orgs/${orgId}/meeting-folder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The name as Google shows it, so the förening page can name the folder without a Drive call.
        body: JSON.stringify({ folderId: picked[0].id, folderName: picked[0].name }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { message?: string } | null;
        setMessage(json?.message ?? t("folderSaveFailed"));
        return;
      }
      setMessage(t("folderSaved"));
      router.refresh();
    } catch (err) {
      setMessage(err instanceof PickerError ? err.message : t("failed"));
    } finally {
      setBusy(false);
    }
  };

  return { pick, busy, message };
}
