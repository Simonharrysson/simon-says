"use client";

import { useEffect } from "react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { IconRefresh } from "@/components/ui/icons";

/** Catches errors thrown while rendering a page (e.g. a database read failing). */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main id="innehall" className="main">
      <div className="page page--narrow oops">
        <p className="oops__code">Fel{error.digest ? ` · ${error.digest}` : ""}</p>
        <h1 className="oops__title">Något gick snett</h1>
        <p className="muted">
          Det är vårt fel, inte ditt. Försök igen om en stund.
        </p>
        <div className="cluster">
          <Button variant="primary" icon={<IconRefresh />} onClick={() => retry()}>
            Försök igen
          </Button>
          <ButtonLink href="/" variant="ghost">
            Till startsidan
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}
