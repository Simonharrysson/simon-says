/** The logo: "Simon Says" set in Instrument Serif (the only place that face is used). No mark, no dot. */
export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <a className="wordmark" href={href}>
      Simon Says
    </a>
  );
}
