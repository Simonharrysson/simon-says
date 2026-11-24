import type { InputHTMLAttributes, ReactNode } from "react";
import { IconAlert } from "./icons";
import { cx } from "./cx";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Keep the label for screen readers only. */
  hideLabel?: boolean;
  mono?: boolean;
}

/** Label + input + hint + error, wired with aria-describedby / aria-invalid. */
export function Field({ id, label, hint, error, hideLabel, mono, className, ...input }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={cx("field", className)}>
      <label htmlFor={id} className={hideLabel ? "visually-hidden" : "label"}>
        {label}
      </label>
      <input
        id={id}
        className={cx("input", mono && "input--mono")}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        {...input}
      />
      {hint && (
        <p id={hintId} className="hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error">
          <IconAlert size={16} />
          {error}
        </p>
      )}
    </div>
  );
}

/** A checkbox with a bold title and an optional explanation underneath. */
export function Check({
  id,
  title,
  children,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { id: string; title: ReactNode; children?: ReactNode }) {
  const bodyId = children ? `${id}-body` : undefined;
  return (
    <label className="check" htmlFor={id}>
      <input id={id} type="checkbox" aria-describedby={bodyId} {...input} />
      <span className="check__title">{title}</span>
      {children && (
        <span id={bodyId} className="check__body">
          {children}
        </span>
      )}
    </label>
  );
}
