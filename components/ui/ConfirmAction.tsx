"use client";

import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger } from "./dialog";
import { Input } from "./input";
import { Label } from "./label";
import { SubmitButton } from "./SubmitButton";

export type FormAction = (form: FormData) => void | Promise<void>;

/**
 * A destructive or irreversible action behind a confirm dialog (shadcn Dialog: focus is trapped,
 * Esc and a backdrop click close, focus returns to the trigger). The dialog's form posts `hidden`
 * fields to `action` unchanged, so server actions keep their signature. With `requireText`, the
 * confirm button stays disabled until the typed value matches (and is posted as `name`).
 * `children`: more fields in the dialog, posted with it (e.g. a name to create something with).
 */
export function ConfirmAction({
  action,
  hidden,
  trigger,
  triggerVariant = "danger-quiet",
  triggerSize = "sm",
  triggerIcon,
  triggerIconOnly,
  title,
  description,
  confirmLabel,
  pendingLabel,
  confirmVariant = "danger",
  requireText,
  disabled,
  children,
}: {
  action: FormAction;
  hidden: Record<string, string>;
  trigger: string;
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  triggerIcon?: ReactNode;
  triggerIconOnly?: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  confirmVariant?: ButtonVariant;
  requireText?: { name: string; value: string; label: ReactNode };
  disabled?: boolean;
  children?: ReactNode;
}) {
  const common = useTranslations("common");
  const id = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const matches = !requireText || typed.trim() === requireText.value;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setTyped("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size={triggerSize} icon={triggerIcon} iconOnly={triggerIconOnly} disabled={disabled}>
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent {...(description ? {} : { "aria-describedby": undefined })}>
        <form action={action}>
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <DialogBody>
            <DialogTitle>{title}</DialogTitle>
            {description && (
              <DialogDescription asChild>
                <div>{description}</div>
              </DialogDescription>
            )}
            {children}
            {requireText && (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-confirm`}>{requireText.label}</Label>
                <Input
                  id={`${id}-confirm`}
                  name={requireText.name}
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  required
                />
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {common("cancel")}
            </Button>
            <SubmitButton variant={confirmVariant} disabled={!matches} pendingLabel={pendingLabel}>
              {confirmLabel}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
