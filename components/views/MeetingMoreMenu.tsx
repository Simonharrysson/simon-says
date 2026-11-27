"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuNote, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconChevronDown } from "@/components/ui/icons";

/**
 * The Nästa möte card's quiet "Mer" menu: the service admins' Testmöte (Utan / Med dagordning),
 * moved out of the way of Förbered and Starta. Starts a server-side replay (POST /api/meetings/test,
 * mode "new" or "agenda") and refreshes the page, which then shows the card's live state.
 */
export function MeetingMoreMenu({ orgId }: { orgId: string }) {
  const t = useTranslations("start");
  const router = useRouter();
  const [starting, setStarting] = useState<null | "new" | "agenda">(null);
  const [error, setError] = useState<string | null>(null);

  async function startTest(mode: "new" | "agenda") {
    setStarting(mode);
    setError(null);
    try {
      const res = await fetch("/api/meetings/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, mode }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      const json = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(json?.message ?? t("startFailed"));
    } catch {
      setError(t("offline"));
    }
    setStarting(null);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" loading={starting !== null} disabled={starting !== null} aria-label={starting ? t("startingTest") : t("hero.more")}>
            {starting ? t("startingTest") : t("hero.more")}
            {!starting && <IconChevronDown size={16} className="ml-1 inline-block align-[-0.2em] text-ink-3" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuNote>{t("test")}</DropdownMenuNote>
          <DropdownMenuItem hint={t("testNewHint")} onSelect={() => void startTest("new")}>
            {t("testNew")}
          </DropdownMenuItem>
          <DropdownMenuItem hint={t("testAgendaHint")} onSelect={() => void startTest("agenda")}>
            {t("testAgenda")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <div className="basis-full">
          <Banner tone="danger" title={t("startFailedTitle")}>
            {error}
          </Banner>
        </div>
      )}
    </>
  );
}
