"use client";

import { forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";

/** Opens and closes a LiveDialog from the button that asks for it. */
export interface LiveDialogHandle {
  showModal: () => void;
  close: () => void;
}

/**
 * The live page's confirm dialog (shadcn Dialog: focus trap, Esc, backdrop click, focus back to
 * the trigger). The safe choice is first and gets focus, so a stray Enter never ends or leaves
 * a meeting.
 */
export const LiveDialog = forwardRef<
  LiveDialogHandle,
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
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ showModal: () => setOpen(true), close: () => setOpen(false) }), []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent id={id}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{children}</DialogDescription>
        </DialogBody>
        <DialogFooter>
          <Button variant={stayVariant} autoFocus onClick={() => setOpen(false)}>
            {stayLabel}
          </Button>
          <Button
            variant={confirmVariant}
            icon={confirmIcon}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const stopCopy =
  "Ljudet stängs av och anteckningarna får en sista genomgång. Det tar ungefär en minut. Det du redan ser i dokumentet ligger kvar.";
