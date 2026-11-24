import { IconDoc, IconExternal } from "@/components/ui/icons";
import { formatClock } from "@/lib/format";

/** The meeting's Google Doc: the real output. Opens in a new tab. */
export function DocLink({
  url,
  title,
  lastUpdatedAt,
  pending,
}: {
  url: string | null;
  title: string;
  /** ISO time of the last successful notes write. */
  lastUpdatedAt?: string | null;
  /** Doc not created yet (meeting starting). */
  pending?: boolean;
}) {
  const meta = pending
    ? "Skapas…"
    : lastUpdatedAt
      ? `Anteckningarna uppdaterades ${formatClock(lastUpdatedAt)}`
      : "Första anteckningarna kommer inom en minut";
  const inner = (
    <>
      <span className="doclink__icon" aria-hidden="true">
        <IconDoc size={22} />
      </span>
      <span className="doclink__main">
        <span className="doclink__title">{title}</span>
        <span className="doclink__meta">{meta}</span>
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
