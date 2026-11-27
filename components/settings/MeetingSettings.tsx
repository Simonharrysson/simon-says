"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FolderStep, VoicesStep } from "@/components/onboarding/steps";
import { useMeetingFolderPicker } from "@/components/views/useMeetingFolderPicker";
import { voiceConsentAction } from "@/app/(app)/orgs/[id]/kom-igang/actions";
import type { BoardRow } from "@/lib/people/board";
import { useSettingsSection } from "./SettingsSections";

// Möten's own editors, rendered by Inställningar → Möten and by Kom igång's steps 3 and 6 alike.

/** The förening's meeting folder in Drive (admins pick it in the Google Picker; saved at once). */
export function MeetingFolderSetting({ orgId, folderName, folderSet, pickerEnabled }: { orgId: string; folderName: string | null; folderSet: boolean; pickerEnabled: boolean }) {
  const folder = useMeetingFolderPicker(orgId);
  return <FolderStep folderName={folderName} folderSet={folderSet} pickerEnabled={pickerEnabled} busy={folder.busy} message={folder.message} onPick={folder.pick} />;
}

/** Who has said yes to having their voice learned later (saved on each tick). */
export function VoicesSetting({ orgId, board, onBoard }: { orgId: string; board: BoardRow[]; onBoard?: () => void }) {
  const router = useRouter();
  const t = useTranslations("onboarding");
  const toSection = useSettingsSection();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <VoicesStep
      people={board.filter((r) => r.personId && r.name).map((r) => ({ personId: r.personId!, name: r.name!, role: r.role, consent: r.voiceConsent }))}
      onConsent={async (personId, consent) => {
        setPending(personId);
        const r = await voiceConsentAction(orgId, personId, consent).catch(() => null);
        setError(r === null ? t("offlineShort") : r.ok ? null : r.message);
        setPending(null);
        router.refresh();
      }}
      pending={pending}
      error={error}
      onBoard={onBoard ?? (() => toSection("styrelsen"))}
    />
  );
}
