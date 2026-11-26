"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { IconPlay, IconStop } from "@/components/ui/icons";
import { formatClock } from "@/lib/format";
import { StartErrorBanner, type StartError } from "./ConsentStep";
import { LiveDialog, stopCopy, type LiveDialogHandle } from "./LiveDialog";

/** Shown when the page finds an unfinished meeting (live, or abandoned < 2 h ago). */
export function ResumeMeeting({
  startedAt,
  orgName,
  onResume,
  onEnd,
  resuming,
  error,
  errorText,
}: {
  startedAt: string;
  orgName: string;
  onResume: () => void;
  onEnd?: () => void;
  resuming?: boolean;
  /** Why "Fortsätt mötet" did not get going (mic blocked, server refused). */
  error?: StartError;
  errorText?: string | null;
}) {
  const dialog = useRef<LiveDialogHandle>(null);
  return (
    <section className="flex flex-col gap-6 rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel" aria-labelledby="resume-title">
      <div className="flex flex-col gap-2">
        <h1 id="resume-title" className="text-2xl">
          Mötet är inte avslutat
        </h1>
        <p className="text-ink-2">
          Mötet i {orgName} startade kl. {formatClock(startedAt)} men avslutades aldrig. Kanske stängdes fliken eller somnade
          datorn. Allt som hann transkriberas finns kvar.
        </p>
      </div>
      {error && <StartErrorBanner error={error} text={errorText} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" icon={<IconPlay size={18} />} onClick={onResume} loading={resuming}>
          Fortsätt mötet
        </Button>
        {onEnd && (
          <Button variant="ghost" size="lg" onClick={() => dialog.current?.showModal()} disabled={resuming}>
            Avsluta mötet
          </Button>
        )}
      </div>
      {onEnd && (
        <LiveDialog
          ref={dialog}
          id="resume-stop"
          title="Avsluta mötet?"
          stayLabel="Avbryt"
          confirmLabel="Avsluta mötet"
          confirmIcon={<IconStop size={16} />}
          onConfirm={onEnd}
        >
          {stopCopy}
        </LiveDialog>
      )}
    </section>
  );
}
