import { IconDoc, IconExternal } from "@/components/ui/icons";
import { formatAgo, formatClock } from "@/lib/format";
import type { DocHealth } from "@/lib/ui/live-status";
import { cn } from "@/lib/utils";

/**
 * The meeting's Google Doc: the real output. Opens in a new tab. The card also answers
 * "is the Doc up to date?" at a glance: green = fresh, grey = behind, red = needs a login.
 */
export function DocLink({
  url,
  title,
  lastUpdatedAt,
  updatedMinutesAgo,
  health = "ok",
  pending,
}: {
  url: string | null;
  title: string;
  /** ISO time of the last successful notes write. */
  lastUpdatedAt?: string | null;
  /** Whole minutes since that write (the caller ticks it), for "för 2 min sedan". */
  updatedMinutesAgo?: number | null;
  health?: DocHealth;
  /** Doc not created yet (meeting starting). */
  pending?: boolean;
}) {
  let tone = "rail";
  let meta: string;
  if (pending) meta = "Skapas…";
  else if (health === "paused") {
    tone = "red";
    meta = "Pausat — logga in igen";
  } else if (health === "stale") {
    meta = lastUpdatedAt
      ? `Senast uppdaterat ${formatClock(lastUpdatedAt)} · vi försöker igen automatiskt`
      : "Inte uppdaterat än · vi försöker igen automatiskt";
  } else if (lastUpdatedAt) {
    tone = "green";
    meta = `Uppdaterat ${updatedMinutesAgo != null ? formatAgo(updatedMinutesAgo) : `kl. ${formatClock(lastUpdatedAt)}`}`;
  } else meta = "Första anteckningarna kommer inom en minut";

  const inner = (
    <>
      <span className="grid size-11 place-items-center rounded-md bg-blue-wash text-blue" aria-hidden="true">
        <IconDoc size={22} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-semibold">{title}</span>
        <span className={cn("inline-flex items-center gap-2 text-sm text-ink-2", tone === "green" && "text-green", tone === "red" && "font-semibold text-red")}>
          {meta}
        </span>
      </span>
      {url && (
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-blue">
          Öppna
          <IconExternal size={16} />
        </span>
      )}
    </>
  );
  return url && !pending ? (
    <a className="grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-lg bg-surface px-6 py-4 text-ink no-underline shadow-panel transition-[box-shadow,transform] duration-200 ease-out hover:no-underline hover:shadow-[0_0_0_1px_var(--rail)]" href={url} target="_blank" rel="noopener noreferrer">
      {inner}
      <span className="sr-only">(Google-dokument, öppnas i ny flik)</span>
    </a>
  ) : (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-lg bg-surface px-6 py-4 text-ink no-underline shadow-panel transition-[box-shadow,transform] duration-200 ease-out opacity-70" aria-busy={pending || undefined}>
      {inner}
    </div>
  );
}
