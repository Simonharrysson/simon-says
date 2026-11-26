"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { IconDoc, IconMic } from "@/components/ui/icons";
import { hintClass } from "@/components/ui/Field";
import { meetingTypeName, type MeetingType } from "@/lib/prepare/types";

/**
 * "Starta möte" on the org page. Starting leads to the live page's consent step
 * (`/meetings/ny/<orgId>`): the consent checkbox, the mic and the Doc are handled there, so the
 * mic can start from that click. Service admins also get the quiet "Testmöte" and "Testmöte med
 * dagordning", which start a server-side replay here (POST /api/meetings/test, mode "new" or
 * "agenda") and refresh the page.
 */
/** An upcoming prepared agenda (Förbered möte, 0033), as the förening page lists it. */
export interface PreparedLink {
  date: string;
  time: string | null;
  kind: MeetingType;
  docUrl: string;
}

const preparedDate = (date: string) =>
  new Intl.DateTimeFormat("sv-SE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Stockholm" }).format(new Date(`${date}T12:00:00Z`));

export function StartMeetingForm({
  orgId,
  shareTranscript,
  showTestMeeting = false,
  prepared = [],
}: {
  orgId: string;
  shareTranscript: boolean;
  /** Admins of the service only (decided on the server): the quiet Testmöte buttons. */
  showTestMeeting?: boolean;
  /** Upcoming prepared agendas; "Starta möte" suggests the first one. */
  prepared?: PreparedLink[];
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
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-3">
        Vi skapar ett nytt Google-dokument i din Drive och delar det med föreningens medlemmar
        {shareTranscript ? ", med transkriptionen i en egen flik." : ". Transkriptionen delas inte."}
      </p>
      {error && (
        <Banner tone="danger" title="Mötet kunde inte starta">
          {error}
        </Banner>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <ButtonLink href={`/meetings/ny/${orgId}`} variant="primary" size="lg" icon={<IconMic />}>
          Starta möte
        </ButtonLink>
        <ButtonLink href={`/orgs/${orgId}/forbered`} variant="secondary" size="lg">
          Förbered möte
        </ButtonLink>
      </div>
      <p className={hintClass}>Förbered möte: Simon Says gör dagordningen med förra veckans uppgifter, du lägger till resten.</p>
      {prepared.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Förberedda möten">
          {prepared.map((p) => (
            <li key={p.date} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span>
                <span className="font-medium">{meetingTypeName(p.kind)}</span> {preparedDate(p.date)}
                {p.time ? ` kl. ${p.time.replace(":", ".")}` : ""}
              </span>
              <a href={p.docUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
                <IconDoc size={14} />
                Dagordning
              </a>
              <a href={`/orgs/${orgId}/forbered`} className="text-ink-3">
                Ändra
              </a>
            </li>
          ))}
        </ul>
      )}
      {showTestMeeting && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={starting !== null} loading={starting === "new"} onClick={() => startTest("new")}>
              Testmöte
            </Button>
            <Button disabled={starting !== null} loading={starting === "agenda"} onClick={() => startTest("agenda")}>
              Testmöte med dagordning
            </Button>
          </div>
          <p className="text-xs text-ink-3">
            Spelar upp ett påhittat möte — ca 3–8 min. Du kan stänga fliken. Med dagordning: ett påhittat veckomöte i
            ett nytt dagordningsdokument; andra gången följer det upp förra testmötets uppgifter.
          </p>
        </div>
      )}
    </div>
  );
}
