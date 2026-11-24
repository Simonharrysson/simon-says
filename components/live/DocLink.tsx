import { IconDoc, IconExternal } from "@/components/ui/icons";
import { formatAgo, formatClock } from "@/lib/format";
import type { DocHealth } from "@/lib/ui/live-status";

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
      <span className="doclink__icon" aria-hidden="true">
        <IconDoc size={22} />
      </span>
      <span className="doclink__main">
        <span className="doclink__title">{title}</span>
        <span className={`doclink__meta doclink__meta--${tone}`}>
          <span className={`magnet magnet--${tone}`} aria-hidden="true" />
          {meta}
        </span>
      </span>
      {url && (
        <span className="doclink__open">
          Öppna
          <IconExternal size={16} />
        </span>
      )}
    </>
  );
  return url && !pending ? (
    <a className="doclink" href={url} target="_blank" rel="noopener noreferrer">
      {inner}
      <span className="visually-hidden">(Google-dokument, öppnas i ny flik)</span>
    </a>
  ) : (
    <div className="doclink doclink--pending" aria-busy={pending || undefined}>
      {inner}
    </div>
  );
}
