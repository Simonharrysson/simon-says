import { parseEvent, type CalendarEvent, type CalendarInfo } from "./events";

// A thin, read-only Google Calendar v3 client over fetch (no googleapis package for Calendar is
// installed). Only titles, times and guests are asked for (`fields`): never descriptions, places or
// conference links. Calendar ids contain "@" and "#": always encoded.

export const CALENDAR_ROOT = "https://www.googleapis.com/";

/** Calendar answered with an error (status kept for the caller). */
export class CalendarApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CalendarApiError";
  }
}

export interface CalendarApi {
  listCalendars(): Promise<CalendarInfo[]>;
  /** Timed events between `from` and `to`, expanded (recurring → instances), by start time. */
  listEvents(calendarId: string, from: Date, to: Date, max?: number): Promise<CalendarEvent[]>;
  /** One event, or null when it is gone, cancelled or all-day. */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null>;
}

const EVENT_FIELDS = "id,status,summary,start(dateTime),end(dateTime),attendees(email,displayName,responseStatus,resource)";

export function calendarApi(opts: {
  accessToken: () => Promise<string>;
  /** Google, or the fake Google server's root in the e2e mode. Ends with "/". */
  root?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): CalendarApi {
  const root = opts.root ?? CALENDAR_ROOT;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = `${root}calendar/v3/${path}?${new URLSearchParams(params)}`;
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${await opts.accessToken()}` },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new CalendarApiError(res.status, `calendar: ${res.status} on ${path.split("/")[0]}`);
    return res.json();
  }

  return {
    async listCalendars() {
      const out: CalendarInfo[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const body = (await get("users/me/calendarList", {
          minAccessRole: "reader",
          maxResults: "250",
          fields: "nextPageToken,items(id,summary,summaryOverride,primary,hidden,deleted)",
          ...(pageToken ? { pageToken } : {}),
        })) as { nextPageToken?: string; items?: { id?: unknown; summary?: unknown; summaryOverride?: unknown; primary?: unknown; hidden?: unknown; deleted?: unknown }[] } | null;
        for (const c of body?.items ?? []) {
          if (typeof c.id !== "string" || c.deleted === true) continue;
          const name = typeof c.summaryOverride === "string" && c.summaryOverride ? c.summaryOverride : typeof c.summary === "string" ? c.summary : c.id;
          out.push({ id: c.id, name: name.slice(0, 200), primary: c.primary === true });
        }
        pageToken = body?.nextPageToken;
        if (!pageToken) break;
      }
      return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name, "sv"));
    },

    async listEvents(calendarId, from, to, max = 500) {
      // Paged (a busy calendar has more events than one page), at most `max` in all.
      const out: CalendarEvent[] = [];
      let pageToken: string | undefined;
      let seen = 0;
      for (let page = 0; page < 4 && seen < max; page++) {
        const body = (await get(`calendars/${encodeURIComponent(calendarId)}/events`, {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: String(Math.min(250, max - seen)),
          fields: `nextPageToken,items(${EVENT_FIELDS})`,
          ...(pageToken ? { pageToken } : {}),
        })) as { items?: unknown[]; nextPageToken?: string } | null;
        const items = body?.items ?? [];
        seen += items.length;
        for (const raw of items) {
          const e = parseEvent(raw);
          if (e) out.push(e);
        }
        pageToken = body?.nextPageToken;
        if (!pageToken) break;
      }
      return out;
    },

    async getEvent(calendarId, eventId) {
      const body = await get(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { fields: EVENT_FIELDS });
      return body ? parseEvent(body) : null;
    },
  };
}
