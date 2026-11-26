import type { ComponentProps, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Checkbox } from "./checkbox";
import { IconAlert } from "./icons";
import { Input } from "./input";
import { Label } from "./label";

/** Hint under a field: 13px, grey. */
export const hintClass = "text-xs text-ink-3";
/** An error line under a field: 13px, red, medium. */
export const fieldErrorClass = "flex items-center gap-2 text-xs font-medium text-red";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Keep the label for screen readers only. */
  hideLabel?: boolean;
  mono?: boolean;
}

/** Label + Input + hint + error, wired with aria-describedby / aria-invalid. */
export function Field({ id, label, hint, error, hideLabel, mono, className, ...input }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </Label>
      <Input
        id={id}
        mono={mono}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        {...input}
      />
      {hint && (
        <p id={hintId} className={hintClass}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={fieldErrorClass}>
          <IconAlert size={16} />
          {error}
        </p>
      )}
    </div>
  );
}

/** A checkbox (shadcn Checkbox) with a bold title and an optional explanation underneath. */
export function Check({
  id,
  title,
  children,
  ...checkbox
}: Omit<ComponentProps<typeof Checkbox>, "title" | "children"> & { id: string; title: ReactNode; children?: ReactNode }) {
  const bodyId = children ? `${id}-body` : undefined;
  return (
    <label className="grid cursor-pointer grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1" htmlFor={id}>
      <Checkbox id={id} aria-describedby={bodyId} className="mt-[0.15rem]" {...checkbox} />
      <span className="font-medium">{title}</span>
      {children && (
        <span id={bodyId} className="col-start-2 text-sm text-ink-2">
          {children}
        </span>
      )}
    </label>
  );
}
