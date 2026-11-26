"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconChevronDown, IconExternal, IconMic } from "@/components/ui/icons";
import { meetingTypeName, type MeetingType } from "@/lib/prepare/types";

/**
 * "Starta möte" on the org page: no explanations, just the choices. Starting leads to the live
 * page's consent step (`/meetings/ny/<orgId>`: consent, mic and Doc are handled there, so the mic
 * can start from that click); "Förbered möte" next to it. When an agenda is prepared, one quiet row
 * above names the next meeting with "Dagordning ↗" and "Ändra". Service admins also get a small
 * "Testmöte" menu (Utan / Med dagordning) that starts a server-side replay here
 * (POST /api/meetings/test, mode "new" or "agenda") and refreshes the page.
 */
/** An upcoming prepared agenda (Förbered möte, 0033), as the förening page lists it. */
export interface PreparedLink {
  date: string;
  time: string | null;
  kind: MeetingType;
  docUrl: string;
}

/** "ons 2 dec" (+ " 12.00"). */
export function nextMeetingWhen(date: string, time: string | null): string {
  const d = new Intl.DateTimeFormat("sv-SE", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Stockholm" })
    .format(new Date(`${date}T12:00:00Z`))
    .replace(/\./g, "");
  return `${d}${time ? ` ${time.replace(":", ".")}` : ""}`;
}

export function StartMeetingForm({
  orgId,
  showTestMeeting = false,
  prepared = [],
}: {
  orgId: string;
  /** Admins of the service only (decided on the server): the quiet Testmöte menu. */
  showTestMeeting?: boolean;
  /** Upcoming prepared agendas, soonest first; the row shows the next one. */
  prepared?: PreparedLink[];
}) {
  const router = useRouter();
  const [starting, setStarting] = useState<null | "new" | "agenda">(null);
  const [error, setError] = useState<string | null>(null);
  const next = prepared[0];

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
    <div className="flex flex-col gap-4">
      {next && (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <span className="text-ink-3">Nästa möte</span>
          <span>
            <span className="font-medium">{meetingTypeName(next.kind)}</span> · {nextMeetingWhen(next.date, next.time)}
          </span>
          <span className="flex items-baseline gap-3">
            <a href={next.docUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
              Dagordning
              <IconExternal size={14} />
            </a>
            <a href={`/orgs/${orgId}/forbered?datum=${next.date}`} className="text-ink-3">
              Ändra
            </a>
          </span>
        </p>
      )}
      {error && (
        <Banner tone="danger" title="Mötet kunde inte starta">
          {error}
        </Banner>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <ButtonLink href={`/meetings/ny/${orgId}`} variant="primary" size="lg" icon={<IconMic />} className="max-sm:w-full">
          Starta möte
        </ButtonLink>
        <ButtonLink href={`/orgs/${orgId}/forbered`} variant="secondary" size="lg" className="max-sm:w-full">
          Förbered möte
        </ButtonLink>
        {showTestMeeting && (
          <div className="max-sm:-ml-2 sm:ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" loading={starting !== null} disabled={starting !== null}>
                  {starting ? "Startar testmöte …" : "Testmöte"}
                  {!starting && <IconChevronDown size={16} className="ml-1 inline-block align-[-0.2em] text-ink-2" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem hint="Ett påhittat möte spelas upp, ca 3–8 min." onSelect={() => void startTest("new")}>
                  Utan dagordning
                </DropdownMenuItem>
                <DropdownMenuItem hint="Ett påhittat veckomöte i ett nytt dagordningsdokument." onSelect={() => void startTest("agenda")}>
                  Med dagordning
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </div>
  );
}
