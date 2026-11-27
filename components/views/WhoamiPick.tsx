"use client";

import { useFormStatus } from "react-dom";
import { Spinner } from "@/components/ui/button";
import { IconArrowRight } from "@/components/ui/icons";

/**
 * One name on "Vem av dessa är du?": the whole row is the submit button (56px, phone first).
 * While it links, the arrow turns into a spinner; the row keeps its size (no layout shift).
 */
export function WhoamiPick({ name, role, pendingLabel }: { name: string; role: string | null; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-busy={pending || undefined}
      disabled={pending}
      className="group flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-md border border-control bg-surface px-4 py-3 text-left transition-[background-color,border-color,transform] duration-120 ease-out hover:border-ink hover:bg-sunk active:scale-[0.99] disabled:cursor-progress"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-[0.1rem]">
        <span className="font-medium wrap-anywhere">{name}</span>
        <span className="min-h-[1lh] text-xs text-ink-3">{pending ? pendingLabel : role}</span>
      </span>
      <span aria-hidden="true" className="grid size-5 flex-none place-items-center text-ink-3 transition-[color,translate] duration-120 group-hover:translate-x-0.5 group-hover:text-ink">
        {pending ? <Spinner /> : <IconArrowRight size={18} />}
      </span>
    </button>
  );
}
