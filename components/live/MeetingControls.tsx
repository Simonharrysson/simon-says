"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { IconPause, IconPlay, IconStop } from "@/components/ui/icons";

/**
 * Paus / Fortsätt and Stopp. Paus is the big, always-reachable button (people ask for it
 * mid-sentence). Stopp asks once, because ending runs the final pass and can't be undone.
 */
export function MeetingControls({
  status,
  onPause,
  onResume,
  onStop,
  busy,
}: {
  status: "live" | "paused" | "ending";
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  /** A pause/resume/stop request is in flight. */
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const ending = status === "ending";
  return (
    <div className="controls">
      {status === "paused" ? (
        <Button variant="primary" size="lg" icon={<IconPlay size={18} />} onClick={onResume} loading={busy} className="controls__main">
          Fortsätt
        </Button>
      ) : (
        <Button
          size="lg"
          icon={<IconPause size={18} />}
          onClick={onPause}
          loading={busy && !ending}
          disabled={ending}
          className="controls__main controls__pause"
        >
          Paus
        </Button>
      )}
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

      <dialog ref={dialog} className="dialog" aria-labelledby="stop-title" onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
        <div className="dialog__body">
          <h2 id="stop-title" className="dialog__title">
            Avsluta mötet?
          </h2>
          <p className="dialog__text">
            Ljudet stängs av och anteckningarna får en sista genomgång. Det tar ungefär en minut. Det du redan ser i
            dokumentet ligger kvar.
          </p>
        </div>
        <div className="dialog__actions">
          <Button variant="ghost" onClick={() => dialog.current?.close()}>
            Fortsätt mötet
          </Button>
          <Button
            variant="danger"
            icon={<IconStop size={16} />}
            onClick={() => {
              dialog.current?.close();
              onStop();
            }}
          >
            Avsluta mötet
          </Button>
        </div>
      </dialog>
    </div>
  );
}
