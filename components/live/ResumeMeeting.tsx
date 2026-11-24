"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { IconPlay, IconStop } from "@/components/ui/icons";
import { formatClock } from "@/lib/format";
import { LiveDialog, stopCopy } from "./LiveDialog";

/** Shown when the page finds an unfinished meeting (live, or abandoned < 2 h ago). */
export function ResumeMeeting({
  startedAt,
  orgName,
  onResume,
  onEnd,
  resuming,
}: {
  startedAt: string;
  orgName: string;
  onResume: () => void;
  onEnd?: () => void;
  resuming?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <section className="resume" aria-labelledby="resume-title">
      <span className="magnet magnet--ink resume__magnet" aria-hidden="true" />
      <div className="stack stack--2">
        <h1 id="resume-title" className="consent__title">
          Mötet är inte avslutat
        </h1>
        <p className="muted">
          Mötet i {orgName} startade kl. {formatClock(startedAt)} men avslutades aldrig. Kanske stängdes fliken eller somnade
          datorn. Allt som hann transkriberas finns kvar.
        </p>
      </div>
      <div className="cluster">
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
