"use client";

import { useTranslations } from "next-intl";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { IconPause, IconPlay, IconStop } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { LiveDialog, type LiveDialogHandle } from "./LiveDialog";

/**
 * Paus / Fortsätt and Avsluta. Paus is the big, always-reachable button (people ask for it
 * mid-sentence). Avsluta asks once, because ending runs the final pass and can't be undone.
 * With `canPause={false}` (the meeting has stopped on its own) only Avsluta is offered.
 */
export function MeetingControls({
  status,
  onPause,
  onResume,
  onStop,
  busy,
  canPause = true,
  className,
}: {
  status: "live" | "paused" | "ending";
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  /** A pause/resume/stop request is in flight. */
  busy?: boolean;
  canPause?: boolean;
  className?: string;
}) {
  const t = useTranslations("live");
  const dialog = useRef<LiveDialogHandle>(null);
  const ending = status === "ending";
  return (
    <div className={cn("flex gap-2 max-[52rem]:[&>button]:flex-1", className)}>
      {canPause &&
        (status === "paused" ? (
          <Button variant="primary" size="lg" icon={<IconPlay size={18} />} onClick={onResume} loading={busy} className="min-w-36">
            {t("controls.resume")}
          </Button>
        ) : (
          <Button
            size="lg"
            icon={<IconPause size={18} />}
            onClick={onPause}
            loading={busy && !ending}
            disabled={ending}
            className="min-w-36 border-[1.5px] border-ink"
          >
            {t("controls.pause")}
          </Button>
        ))}
      <Button
        size="lg"
        variant="danger-quiet"
        icon={<IconStop size={16} />}
        onClick={() => dialog.current?.showModal()}
        disabled={ending}
        loading={ending}
      >
        {ending ? t("controls.ending") : t("controls.end")}
      </Button>

      <LiveDialog
        ref={dialog}
        id="stop"
        title={t("controls.endTitle")}
        stayLabel={t("controls.stay")}
        confirmLabel={t("controls.confirmEnd")}
        confirmIcon={<IconStop size={16} />}
        onConfirm={onStop}
      >
        {t("stopCopy")}
      </LiveDialog>
    </div>
  );
}
