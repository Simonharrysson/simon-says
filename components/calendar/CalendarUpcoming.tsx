"use client";

import { useLocale, useTranslations } from "next-intl";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { ButtonLink } from "@/components/ui/button";
import { nextMeetingWhen } from "@/components/views/StartMeetingForm";
import { ConnectCalendarButton } from "./CalendarConnect";

/** An upcoming event of the förening's calendar (todo #14), as the card lists it. */
export interface CalendarEventLink {
  id: string;
  title: string;
  /** Swedish local `YYYY-MM-DD` and `HH:MM`. */
  date: string;
  time: string;
  /** From 30 minutes before its start until its end: "Starta" is offered. */
  now: boolean;
}

/** The card's calendar part: absent when the förening has no calendar. */
export type StartCalendar =
  | { state: "ok"; events: CalendarEventLink[] }
  | { state: "disconnected"; connect: FormAction }
  | { state: "unavailable" };

/**
 * The Starta möte card's calendar part (todo #14): the next events of the förening's calendar with
 * "Förbered" and, for the one happening now, "Starta"; or a quiet line saying why there are none.
 */
export function CalendarUpcoming({ orgId, calendar }: { orgId: string; calendar: StartCalendar }) {
  const tCal = useTranslations("calendar");
  const locale = useLocale();
  return (
    <>
      {calendar.state === "ok" &&
        (calendar.events.length ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-ink-3" id="calendar-upcoming">
              {tCal("upcomingLabel")}
            </p>
            <ul aria-labelledby="calendar-upcoming" className="divide-y divide-line">
              {calendar.events.map((e) => {
                const title = e.title || tCal("untitled");
                return (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2 text-sm">
                    <span className="min-w-0 wrap-anywhere">
                      <span className="font-medium">{title}</span>
                      <span className="text-ink-2"> · {nextMeetingWhen(e.date, e.time, locale)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {e.now && (
                        <ButtonLink href={`/meetings/ny/${orgId}?event=${encodeURIComponent(e.id)}`} variant="primary" size="sm" aria-label={tCal("startLabel", { title })}>
                          {tCal("start")}
                        </ButtonLink>
                      )}
                      <ButtonLink
                        href={`/orgs/${orgId}/forbered?datum=${e.date}&event=${encodeURIComponent(e.id)}`}
                        variant="ghost"
                        size="sm"
                        aria-label={tCal("prepareLabel", { title })}
                      >
                        {tCal("prepare")}
                      </ButtonLink>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-ink-3">{tCal("nothingUpcoming")}</p>
        ))}
      {calendar.state === "disconnected" && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-ink-3">{tCal("connectHint")}</span>
          <ConnectCalendarButton action={calendar.connect} back={`/orgs/${orgId}`} variant="ghost" />
        </div>
      )}
      {calendar.state === "unavailable" && <p className="text-sm text-ink-3">{tCal("unavailable")}</p>}
    </>
  );
}
