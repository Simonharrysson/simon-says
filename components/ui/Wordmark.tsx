/** The name with its ink magnet (red is kept for things that are really live). */
export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <a className="wordmark" href={href}>
      <span className="magnet magnet--ink" aria-hidden="true" />
      Simon Says
    </a>
  );
}
