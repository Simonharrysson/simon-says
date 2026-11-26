"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { IconPlay, IconStop } from "@/components/ui/icons";
import { formatClock } from "@/lib/format";
import { StartErrorBanner, type StartError } from "./ConsentStep";
import { LiveDialog, stopCopy, type LiveDialogHandle } from "./LiveDialog";

/**
 * Shown when the page finds an unfinished meeting (live, or abandoned < 2 h ago). When another
 * tab records it right now (`connectedElsewhere`), continuing here takes it over from that tab.
 */
export function ResumeMeeting({
  startedAt,
  orgName,
  onResume,
  connectedElsewhere,
  live = true,
  onEnd,
  resuming,
  error,
  errorText,
}: {
  startedAt: string;
  orgName: string;
  onResume: () => void;
  connectedElsewhere?: boolean;
  /** Still live on the server (not an abandoned one): it ends by itself if nobody continues. */
  live?: boolean;
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
          {connectedElsewhere ? "Mötet spelas in på en annan dator" : "Mötet är inte avslutat"}
        </h1>
        {connectedElsewhere ? (
          <p className="text-ink-2">
            Mötet i {orgName} startade kl. {formatClock(startedAt)} och spelas in i en annan flik just nu. Tar du över här
            slutar den andra fliken lyssna. Allt som sagts finns kvar.
          </p>
        ) : (
          <p className="text-ink-2">
            Mötet i {orgName} startade kl. {formatClock(startedAt)}, men ingen spelar in det just nu. Kanske stängdes fliken
            eller somnade datorn. Allt som hann transkriberas finns kvar.
            {live && " Fortsätter ingen inom några minuter avslutas mötet av sig självt och anteckningarna görs klara."}
          </p>
        )}
      </div>
      {error && <StartErrorBanner error={error} text={errorText} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" icon={<IconPlay size={18} />} onClick={onResume} loading={resuming}>
          {connectedElsewhere ? "Ta över här" : "Fortsätt mötet"}
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
