/** The name with its red magnet. */
export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <a className="wordmark" href={href}>
      <span className="magnet" aria-hidden="true" />
      Simon Says
    </a>
  );
}
