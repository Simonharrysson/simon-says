"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { IconArrowRight } from "@/components/ui/icons";

/**
 * Inställningar → Föreningen, once Kom igång's card is hidden: a quiet way back to the checklist.
 * `reopen` (dismissAction with false) brings the card back, then the checklist opens.
 */
export function ReopenKomIgang({ orgId, reopen }: { orgId: string; reopen?: () => Promise<unknown> }) {
  const t = useTranslations("org.settings");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1">
      <p className="text-sm text-ink-3">{t("reopenHint")}</p>
      <Button
        variant="ghost"
        size="sm"
        loading={busy}
        icon={<IconArrowRight size={16} />}
        onClick={async () => {
          setBusy(true);
          await reopen?.().catch(() => null);
          router.push(`/orgs/${orgId}/kom-igang`);
        }}
      >
        {t("reopen")}
      </Button>
    </div>
  );
}
