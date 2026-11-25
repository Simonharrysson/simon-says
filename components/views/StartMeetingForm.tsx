"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink } from "@/components/ui/Button";
import { IconMic } from "@/components/ui/icons";

/**
 * "Starta möte" on the org page. Starting leads to the live page's consent step
 * (`/meetings/ny/<orgId>`): the consent checkbox, the mic and the Doc are handled there, so the
 * mic can start from that click. Service admins also get the quiet "Testmöte" and "Testmöte med
 * dagordning", which start a server-side replay here (POST /api/meetings/test, mode "new" or
 * "agenda") and refresh the page.
 */
export function StartMeetingForm({
  orgId,
  shareTranscript,
  showTestMeeting = false,
}: {
  orgId: string;
  shareTranscript: boolean;
  /** Admins of the service only (decided on the server): the quiet Testmöte buttons. */
  showTestMeeting?: boolean;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState<null | "new" | "agenda">(null);
  const [error, setError] = useState<string | null>(null);

  async function startTest(mode: "new" | "agenda") {
    setStarting(mode);
    setError(null);
    try {
      const res = await fetch("/api/meetings/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, mode }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      const json = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(json?.message ?? "Mötet kunde inte starta. Försök igen om en liten stund.");
    } catch {
      setError("Vi nådde inte servern. Kontrollera nätet och försök igen.");
    }
    setStarting(null);
  }

  return (
    <div className="stack stack--3">
      <p className="subtle">
        Vi skapar ett nytt Google-dokument i din Drive och delar det med föreningens medlemmar
        {shareTranscript ? ", med transkriptionen i en egen flik." : ". Transkriptionen delas inte."}
      </p>
      {error && (
        <Banner tone="danger" title="Mötet kunde inte starta">
          {error}
        </Banner>
      )}
      <div>
        <ButtonLink href={`/meetings/ny/${orgId}`} variant="primary" size="lg" icon={<IconMic />}>
          Starta möte
        </ButtonLink>
      </div>
      {showTestMeeting && (
        <div className="stack stack--2">
          <div className="cluster">
            <Button disabled={starting !== null} loading={starting === "new"} onClick={() => startTest("new")}>
              Testmöte
            </Button>
            <Button disabled={starting !== null} loading={starting === "agenda"} onClick={() => startTest("agenda")}>
              Testmöte med dagordning
            </Button>
          </div>
          <p className="hint">
            Spelar upp ett påhittat möte — ca 3–8 min. Du kan stänga fliken. Med dagordning: ett påhittat veckomöte i
            ett nytt dagordningsdokument; andra gången följer det upp förra testmötets uppgifter.
          </p>
        </div>
      )}
    </div>
  );
}
