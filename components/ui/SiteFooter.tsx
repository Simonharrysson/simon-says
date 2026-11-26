const REPO = "https://github.com/Simonharrysson/simon-says";

export function SiteFooter() {
  return (
    <footer className="border-t border-line py-8 text-sm text-ink-3 [&_a]:text-ink-2">
      <div className="mx-auto flex w-full max-w-page flex-wrap items-center justify-between gap-x-6 gap-y-3 px-gutter">
        <p>Simon Says · gratis för föreningar i Linköping · Harrysson &amp; Company AB</p>
        <nav aria-label="Sidfot" className="flex flex-wrap items-center gap-5">
          <a href="/status">Status</a>
          <a href="/integritet">Integritet</a>
          <a href={REPO} rel="noopener">
            Källkod på GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
