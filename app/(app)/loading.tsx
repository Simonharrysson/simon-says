/** Skeleton while a logged-in page reads its data. */
export default function Loading() {
  return (
    <div className="page stack" style={{ ["--stack-gap" as string]: "1.5rem" }} aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Laddar…</span>
      <div className="skeleton" style={{ height: "2.5rem", width: "min(20rem, 70%)" }} />
      <div className="skeleton" style={{ height: "1rem", width: "12rem" }} />
      <div className="org-grid">
        <div className="skeleton" style={{ height: "16rem", borderRadius: "14px" }} />
        <div className="skeleton" style={{ height: "10rem", borderRadius: "14px" }} />
      </div>
    </div>
  );
}
