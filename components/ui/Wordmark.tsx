/** The logo: "Simon Says" set in Instrument Serif 400 (the only place that face is used; never faux-bolded). No mark, no dot. */
export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <a
      className="inline-flex min-h-11 items-center font-logo text-[1.625rem] leading-none font-normal tracking-[-0.01em] whitespace-nowrap text-ink no-underline [font-synthesis:none] hover:no-underline"
      href={href}
    >
      Simon Says
    </a>
  );
}
