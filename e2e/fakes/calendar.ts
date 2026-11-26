// The fake Google Calendar v3 (read-only parts the app calls: calendarList, events.list,
// events.get), shared by the e2e fake server and the vitest of lib/calendar/api.ts. State in memory.
// A user sees a calendar only when it is in their own list (seeded per e-mail).

export interface FakeCalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  status?: string;
  allDay?: boolean;
  description?: string;
  attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
}

export interface FakeCalendar {
  id: string;
  summary: string;
  primary?: boolean;
}

export class CalendarFake {
  /** user e-mail → their calendar list. */
  readonly lists = new Map<string, FakeCalendar[]>();
  /** calendar id → events. */
  readonly events = new Map<string, FakeCalendarEvent[]>();
  /** Paths requested (for tests: which fields were asked for). */
  readonly requests: string[] = [];

  /** Control: give `email` a calendar (and its events, appended). */
  seed(email: string, calendar: FakeCalendar, events: FakeCalendarEvent[] = []): void {
    const list = (this.lists.get(email.toLowerCase()) ?? []).filter((c) => c.id !== calendar.id);
    this.lists.set(email.toLowerCase(), [...list, calendar]);
    this.events.set(calendar.id, [...(this.events.get(calendar.id) ?? []), ...events]);
  }

  /** Answers a request below `calendar/v3/`, or null when the path is not Calendar's. */
  handle(method: string, path: string, url: URL, user: string): { status: number; body: unknown } | null {
    if (!path.startsWith("calendar/v3/")) return null;
    this.requests.push(`${method} ${path}?${url.searchParams}`);
    if (!user) return { status: 401, body: { error: { code: 401, message: "no credentials" } } };
    if (method !== "GET") return { status: 405, body: { error: { code: 405, message: "read only" } } };
    const rest = path.slice("calendar/v3/".length);
    const mine = this.lists.get(user.toLowerCase()) ?? [];
    if (rest === "users/me/calendarList") {
      return { status: 200, body: { items: mine.map((c) => ({ id: c.id, summary: c.summary, primary: c.primary === true })) } };
    }
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^calendars\/([^/]+)\/events(?:\/([^/]+))?$/))) {
      const calendarId = decodeURIComponent(m[1]);
      if (!mine.some((c) => c.id === calendarId)) return { status: 404, body: { error: { code: 404, message: "Not Found" } } };
      const all = this.events.get(calendarId) ?? [];
      if (m[2]) {
        const e = all.find((x) => x.id === decodeURIComponent(m![2]));
        return e ? { status: 200, body: this.render(e) } : { status: 404, body: { error: { code: 404, message: "Not Found" } } };
      }
      const from = Date.parse(url.searchParams.get("timeMin") ?? "") || -Infinity;
      const to = Date.parse(url.searchParams.get("timeMax") ?? "") || Infinity;
      const max = Number(url.searchParams.get("maxResults") ?? 250);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const matching = all
        .filter((e) => e.status !== "cancelled" && Date.parse(e.end) > from && Date.parse(e.start) < to)
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const items = matching.slice(offset, offset + max).map((e) => this.render(e));
      const next = offset + max < matching.length ? { nextPageToken: String(offset + max) } : {};
      return { status: 200, body: { items, ...next } };
    }
    return { status: 404, body: { error: { code: 404, message: `fake calendar: no route ${rest}` } } };
  }

  private render(e: FakeCalendarEvent) {
    // Like Google with `fields`: no description comes back.
    return {
      id: e.id,
      status: e.status ?? "confirmed",
      summary: e.summary,
      start: e.allDay ? { date: e.start.slice(0, 10) } : { dateTime: e.start },
      end: e.allDay ? { date: e.end.slice(0, 10) } : { dateTime: e.end },
      ...(e.attendees ? { attendees: e.attendees } : {}),
    };
  }
}
