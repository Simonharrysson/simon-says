"use client";

import { forwardRef, type ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";

/**
 * A native confirm dialog for the live page (focus trap, Esc, backdrop click). The safe choice
 * is first and gets focus, so a stray Enter never ends or leaves a meeting.
 */
export const LiveDialog = forwardRef<
  HTMLDialogElement,
  {
    id: string;
    title: string;
    children: ReactNode;
    stayLabel: string;
    confirmLabel: string;
    confirmVariant?: ButtonVariant;
    /** The safe choice; `primary` when leaving is the risky one (leave dialog). */
    stayVariant?: ButtonVariant;
    confirmIcon?: ReactNode;
    onConfirm: () => void;
  }
>(function LiveDialog({ id, title, children, stayLabel, confirmLabel, confirmVariant = "danger", stayVariant = "ghost", confirmIcon, onConfirm }, ref) {
  const dialog = () => (typeof ref === "object" ? ref?.current : null);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-title`} onClick={(e) => e.target === dialog() && dialog()?.close()}>
      <div className="dialog__body">
        <h2 id={`${id}-title`} className="dialog__title">
          {title}
        </h2>
        <p className="dialog__text">{children}</p>
      </div>
      <div className="dialog__actions">
        <Button variant={stayVariant} autoFocus onClick={() => dialog()?.close()}>
          {stayLabel}
        </Button>
        <Button
          variant={confirmVariant}
          icon={confirmIcon}
          onClick={() => {
            dialog()?.close();
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
});

export const stopCopy =
  "Ljudet stängs av och anteckningarna får en sista genomgång. Det tar ungefär en minut. Det du redan ser i dokumentet ligger kvar.";
