import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CountUp } from "@/components/motion/CountUp";
import { Enter } from "@/components/motion/Enter";
import { AppLink } from "@/components/ui/AppLink";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { cardClass } from "@/components/ui/card";
import { IconArrowRight, IconCheck, IconClock, IconExternal, IconMic, IconPlay } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectCalendarButton } from "@/components/calendar/CalendarConnect";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { formatDuration } from "@/lib/format";
import { stockholmDay } from "@/lib/home/tasks";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { HeroDay, HeroState } from "@/lib/meetings/next-meeting";
import type { SummaryStatus } from "@/lib/meetings/recap";
import { cn } from "@/lib/utils";
import { RefreshWhile } from "./RefreshWhile";

/** "ons 2 dec" (+ " 12.00"); English "Wed 2 Dec" (+ " 12:00"). */
export function nextMeetingWhen(date: string, time: string | null, locale: Locale = "sv"): string {
  const d = new Intl.DateTimeFormat(intlTag(locale), { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Stockholm" })
    .format(new Date(`${date}T12:00:00Z`))
    .replace(/\./g, "")
    .replace(/,/g, "");
  return `${d}${time ? ` ${locale === "en" ? time.slice(0, 5) : time.slice(0, 5).replace(":", ".")}` : ""}`;
}

/** "18.02" / "18:02", Stockholm time. */
function clock(iso: string, locale: Locale): string {
  const s = new Intl.DateTimeFormat(intlTag(locale), { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" }).format(new Date(iso));
  return locale === "en" ? s : s.replace(":", ".");
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const dayKey = (day: HeroDay | null) => (!day ? "other" : day.type === "weekday" ? WEEKDAYS[day.weekday] : day.type === "date" ? "other" : day.type);

/** An upcoming event of the förening's calendar (todo #14), as the card shows it. */
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

/** The meeting the card is about (live, ending, just ended), from the page's own lists. */
export interface HeroMeetingInfo {
  id: string;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
  decisions: number;
  tasks: number;
}

/** The calendar's part: `loading` while Google answers (the card keeps its size). Absent: no calendar. */
export type HeroCalendar = StartCalendar | { state: "loading" };

export interface NextMeetingHeroProps {
  orgId: string;
  state: HeroState;
  meeting?: HeroMeetingInfo | null;
  /** Just ended: what happened to the summary e-mail. */
  summary?: SummaryStatus | null;
  /** Live: may this viewer continue it on this device (signed in, the live page exists). */
  continueHref?: string | null;
  /** Live: where the notes are written (the Doc link, or "ask for access"). */
  liveDoc?: ReactNode;
  calendar?: HeroCalendar;
  /** The quiet "Mer" menu (service admins: Testmöte). */
  more?: ReactNode;
  /** A Företag: "Starta möte" goes straight to the start screen (no Förbered there). */
  foretag?: boolean;
}

/**
 * The Möten tab's "Nästa möte" card: the weekly loop in one place, its state from
 * `nextMeetingState` (lib/meetings/next-meeting.ts). Not prepared ("Förbered tisdagens möte" /
 * "Starta utan förberedelse") → prepared (Dagordning, "Starta mötet") → live ("Fortsätt mötet") →
 * notes being finished → just ended (recap, the summary e-mail, "Se beslut och uppgifter"). Each
 * state rises in when it replaces another (a client render), never on a page load.
 */
export function NextMeetingHero(props: NextMeetingHeroProps) {
  const { orgId, state, more } = props;
  const t = useTranslations("start.hero");
  const tForetag = useTranslations("foretag");
  const tCal = useTranslations("calendar");
  const tTypes = useTranslations("formats.meetingTypes");
  const tOrg = useTranslations("org");
  const locale = useLocale() as Locale;
  const m = props.meeting;

  let label: ReactNode = t("label");
  let title: ReactNode;
  let text: ReactNode = null;
  let extra: ReactNode = null;
  let actions: ReactNode = null;

  const calendarLine = (): ReactNode => {
    const cal = props.calendar;
    if (!cal || (state.kind !== "prepared" && state.kind !== "unprepared")) return null;
    let line: ReactNode = null;
    if (cal.state === "loading") line = <Skeleton className="h-4 w-56 max-w-full" aria-label={t("calendarLoading")} />;
    else if (cal.state === "unavailable") line = <span className="truncate">{tCal("unavailable")}</span>;
    else if (cal.state === "disconnected")
      line = (
        <>
          <span className="min-w-0 truncate">{tCal("connectHint")}</span>
          <ConnectCalendarButton action={cal.connect} back={`/orgs/${orgId}`} variant="ghost" />
        </>
      );
    else if (state.kind === "prepared")
      line = state.event ? (
        <span className="truncate">{t("calendarSame", { title: state.event.title || tCal("untitled") })}</span>
      ) : cal.events[0] ? (
        <span className="truncate">{t("calendarLater", { title: cal.events[0].title || tCal("untitled"), when: nextMeetingWhen(cal.events[0].date, cal.events[0].time, locale) })}</span>
      ) : (
        <span className="truncate">{tCal("nothingUpcoming")}</span>
      );
    else if (!state.event) line = <span className="truncate">{tCal("nothingUpcoming")}</span>;
    else line = <span className="truncate">{t("calendarWhen", { when: nextMeetingWhen(state.event.date, state.event.time, locale) })}</span>;
    return <div className="flex min-h-8 min-w-0 items-center gap-3 text-sm text-ink-3">{line}</div>;
  };

  switch (state.kind) {
    case "live": {
      label = (
        <>
          <Badge tone="live">{t("liveBadge")}</Badge>
          {m && <span>{t("liveSince", { time: clock(m.startedAt, locale) })}</span>}
        </>
      );
      title = t("liveTitle");
      text = props.liveDoc;
      actions = props.continueHref ? (
        <ButtonLink href={props.continueHref} variant="primary" size="lg" icon={<IconPlay size={18} />} className="max-sm:w-full">
          {t("continue")}
        </ButtonLink>
      ) : null;
      break;
    }
    case "ending": {
      label = <Badge tone="neutral">{t("endingBadge")}</Badge>;
      title = t("endingTitle");
      text = t("endingText");
      extra = <RefreshWhile ms={5000} />;
      break;
    }
    case "ended": {
      label = (
        <>
          <span>{t("endedLabel")}</span>
          <Badge tone="success">{t("endedBadge")}</Badge>
        </>
      );
      title = m?.title ?? (m ? nextMeetingWhen(stockholmDay(m.startedAt), null, locale) : t("endedLabel"));
      const seconds = m?.endedAt ? (Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 1000 : null;
      text = m ? (
        <>
          <CountUp text={tOrg("itemCounts", { decisions: m.decisions, tasks: m.tasks })} />
          {seconds !== null && seconds >= 0 && ` · ${formatDuration(seconds, locale)}`}
        </>
      ) : null;
      const s = props.summary;
      extra =
        s && s.state !== "none" ? (
          <p className="flex items-center gap-2 text-sm text-ink-2">
            {s.state === "pending" ? <IconClock size={16} className="flex-none text-ink-3" /> : <IconCheck size={16} className={cn("flex-none", s.state === "sent" ? "text-green" : "text-ink-3")} />}
            {s.state === "sent" ? t("summarySent", { count: s.sent }) : s.state === "pending" ? t("summaryPending") : t("summaryOff")}
          </p>
        ) : null;
      actions = (
        <>
          {m && (
            <ButtonLink href={`/orgs/${orgId}/mote/${m.id}`} variant="primary" size="lg" icon={<IconArrowRight size={18} />} className="max-sm:w-full">
              {t("toMeeting")}
            </ButtonLink>
          )}
          {!props.foretag && (
            <ButtonLink href={`/orgs/${orgId}/forbered`} variant="secondary" size="lg" className="max-sm:w-full">
              {t("prepareNext")}
            </ButtonLink>
          )}
        </>
      );
      break;
    }
    case "prepared": {
      const p = state.prepared;
      title = `${tTypes(`${p.kind}.name`)} · ${nextMeetingWhen(p.date, p.time, locale)}`;
      text = (
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span>{t("preparedText")}</span>
          <a href={p.docUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
            {t("agenda")}
            <IconExternal size={14} />
          </a>
          <AppLink href={`/orgs/${orgId}/forbered?datum=${p.date}`} className="text-ink-3">
            {t("change")}
          </AppLink>
        </span>
      );
      extra = calendarLine();
      actions = (
        <ButtonLink href={`/meetings/ny/${orgId}${state.event?.now ? `?event=${encodeURIComponent(state.event.id)}` : ""}`} variant="primary" size="lg" icon={<IconMic />} className="max-sm:w-full">
          {t("startPrepared")}
        </ButtonLink>
      );
      break;
    }
    case "unprepared": {
      const ev = state.event;
      title = ev ? ev.title || tCal("untitled") : t("notPreparedTitle");
      text = ev ? (ev.now ? t("eventNowText") : t("eventText")) : t("notPreparedText");
      extra = calendarLine();
      const prepareHref = ev ? `/orgs/${orgId}/forbered?datum=${ev.date}&event=${encodeURIComponent(ev.id)}` : `/orgs/${orgId}/forbered`;
      const startHref = `/meetings/ny/${orgId}${ev?.now ? `?event=${encodeURIComponent(ev.id)}` : ""}`;
      const prepareLabel = state.day?.type === "date" ? t("prepareDate", { date: nextMeetingWhen(state.day.date, null, locale) }) : t(`prepare.${dayKey(state.day)}`);
      actions = ev?.now ? (
        // Happening now: starting is the thing to do; preparing comes second.
        <>
          <ButtonLink href={startHref} variant="primary" size="lg" icon={<IconMic />} className="max-sm:w-full">
            {t("start")}
          </ButtonLink>
          <ButtonLink href={prepareHref} variant="secondary" size="lg" className="max-sm:w-full">
            {prepareLabel}
          </ButtonLink>
        </>
      ) : (
        <>
          <ButtonLink href={prepareHref} variant="primary" size="lg" className="max-sm:w-full">
            {prepareLabel}
          </ButtonLink>
          <ButtonLink href={startHref} variant="secondary" size="lg" icon={<IconMic />} className="max-sm:w-full">
            {t("startWithout")}
          </ButtonLink>
        </>
      );
      break;
    }
    case "start": {
      // A Företag: who the meeting is for is chosen on the start screen.
      title = tForetag("start.title");
      text = tForetag("start.text");
      actions = (
        <ButtonLink href={`/meetings/ny/${orgId}`} variant="primary" size="lg" icon={<IconMic />} className="max-sm:w-full">
          {t("start")}
        </ButtonLink>
      );
      break;
    }
  }

  return (
    <section data-slot="card" data-hero={state.kind} className={cn(cardClass, "p-6")} aria-labelledby="next-meeting-title">
      <Enter key={state.kind}>
        <div data-enter-item className="flex flex-col gap-4">
          <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p className="flex items-center gap-2 text-sm font-medium text-ink-3">{label}</p>
            {more}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="next-meeting-title" className="text-xl tracking-[-0.02em] wrap-anywhere">
              {title}
            </h2>
            {text && <div className="text-ink-2">{text}</div>}
          </div>
          {extra}
          {actions && <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">{actions}</div>}
        </div>
      </Enter>
    </section>
  );
}
