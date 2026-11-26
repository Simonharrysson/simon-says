"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { IconPause, IconPlay, IconStop } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { LiveDialog, stopCopy, type LiveDialogHandle } from "./LiveDialog";

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
  const dialog = useRef<LiveDialogHandle>(null);
  const ending = status === "ending";
  return (
    <div className={cn("flex gap-2 max-[52rem]:[&>button]:flex-1", className)}>
      {canPause &&
        (status === "paused" ? (
          <Button variant="primary" size="lg" icon={<IconPlay size={18} />} onClick={onResume} loading={busy} className="min-w-36">
            Fortsätt
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
            Paus
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
        {ending ? "Avslutar…" : "Avsluta"}
      </Button>

      <LiveDialog
        ref={dialog}
        id="stop"
        title="Avsluta mötet?"
        stayLabel="Fortsätt mötet"
        confirmLabel="Avsluta mötet"
        confirmIcon={<IconStop size={16} />}
        onConfirm={onStop}
      >
        {stopCopy}
      </LiveDialog>
    </div>
  );
}
