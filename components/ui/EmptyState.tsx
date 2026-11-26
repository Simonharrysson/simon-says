import type { ReactNode } from "react";

/** Dashed outline on the board: nothing here yet, and what to do about it. */
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-rail px-6 py-8 text-ink-2">
      <p className="text-base font-semibold text-ink">{title}</p>
      {children && <div className="max-w-[34rem] text-sm">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
