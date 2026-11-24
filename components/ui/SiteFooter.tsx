const REPO = "https://github.com/Simonharrysson/simon-says";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="page site-footer__inner">
        <p>Simon Says · gratis för föreningar i Linköping · Harrysson &amp; Company AB</p>
        <nav aria-label="Sidfot" className="cluster" style={{ ["--cluster-gap" as string]: "1.25rem" }}>
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
