"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { SubmitButton } from "./SubmitButton";

export type FormAction = (form: FormData) => void | Promise<void>;

/**
 * A destructive or irreversible action behind a confirm dialog (native <dialog>: focus is
 * trapped, Esc closes, focus returns to the trigger). The dialog's form posts `hidden` fields
 * to `action` unchanged, so server actions keep their signature. With `requireText`, the
 * confirm button stays disabled until the typed value matches (and is posted as `name`).
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
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [typed, setTyped] = useState("");
  const matches = !requireText || typed.trim() === requireText.value;

  const close = () => {
    ref.current?.close();
    setTyped("");
  };

  return (
    <>
      <Button
        variant={triggerVariant}
        size={triggerSize}
        icon={triggerIcon}
        iconOnly={triggerIconOnly}
        disabled={disabled}
        onClick={() => ref.current?.showModal()}
        aria-haspopup="dialog"
      >
        {trigger}
      </Button>
      <dialog
        ref={ref}
        className="dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        onClose={() => setTyped("")}
        onClick={(event) => {
          // Click on the backdrop (the dialog element itself, outside the body) closes.
          if (event.target === ref.current) close();
        }}
      >
        <form action={action}>
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <div className="dialog__body">
            <h2 className="dialog__title" id={`${id}-title`}>
              {title}
            </h2>
            {description && (
              <div className="dialog__text" id={`${id}-desc`}>
                {description}
              </div>
            )}
            {requireText && (
              <div className="field">
                <label className="label" htmlFor={`${id}-confirm`}>
                  {requireText.label}
                </label>
                <input
                  id={`${id}-confirm`}
                  name={requireText.name}
                  className="input"
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  required
                />
              </div>
            )}
          </div>
          <div className="dialog__actions">
            <Button variant="ghost" onClick={close}>
              Avbryt
            </Button>
            <SubmitButton variant={confirmVariant} disabled={!matches} pendingLabel={pendingLabel}>
              {confirmLabel}
            </SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}
