// The internal dashboard (/admin, 0064) in the /design gallery, with fictional numbers and orgs.

import { AdminView } from "@/components/admin/AdminView";
import type { AdminOrgRow, AdminOverview, AdminWeek } from "@/lib/admin/stats";

export const adminViews = [
  { id: "admin", title: "Insikter · internt, med fel senaste veckan" },
  { id: "admin-quiet", title: "Insikter · nystartat, inga fel" },
];

const mondays = (n: number): string[] => {
  const d = new Date(Date.UTC(2026, 10, 23));
  return Array.from({ length: n }, (_, i) => new Date(d.getTime() - (n - 1 - i) * 7 * 86_400_000).toISOString().slice(0, 10));
};
const weeks = (meetings: number[], users: number[]): AdminWeek[] => mondays(12).map((week, i) => ({ week, meetings: meetings[i], users: users[i] }));

const busy: AdminOverview = {
  users: 214,
  active7: 61,
  active30: 132,
  orgs: { forening: 23, foretag: 3, privat: 88 },
  meetings: 1047,
  meetings7: 38,
  minutes30: 9120,
  weeks: weeks([12, 18, 15, 22, 27, 25, 31, 29, 36, 41, 44, 19], [4, 6, 3, 9, 12, 8, 7, 14, 11, 16, 13, 5]),
  health: { summaries: 1, summaryMails: 2, briefs: 0, invites: 0 },
};

const quiet: AdminOverview = {
  users: 3,
  active7: 2,
  active30: 3,
  orgs: { forening: 1, foretag: 0, privat: 2 },
  meetings: 4,
  meetings7: 1,
  minutes30: 95,
  weeks: weeks([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 1], [0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0]),
  health: { summaries: 0, summaryMails: 0, briefs: 0, invites: 0 },
};

const org = (id: string, name: string, kind: AdminOrgRow["kind"], members: number, meetings: number, last: string | null, created: string): AdminOrgRow => ({ id, name, kind, members, meetings, lastMeetingAt: last, createdAt: created });
const orgs: AdminOrgRow[] = [
  org("o1", "Roddklubben Stångån", "forening", 14, 212, "2026-11-27T18:00:00Z", "2026-03-02T10:00:00Z"),
  org("o2", "Linköpings Schacksällskap", "forening", 9, 96, "2026-11-25T17:30:00Z", "2026-04-11T09:00:00Z"),
  org("o3", "Norrbacka Bygg AB", "foretag", 22, 140, "2026-11-28T07:45:00Z", "2026-09-30T12:00:00Z"),
  org("o4", "Studentkören Cantus", "forening", 31, 58, "2026-11-12T19:00:00Z", "2026-05-20T15:00:00Z"),
  org("o5", "Privat", "privat", 1, 17, "2026-11-26T08:10:00Z", "2026-10-04T08:00:00Z"),
  org("o6", "Husbyggarföreningen Ekholmen", "forening", 6, 0, null, "2026-11-20T20:00:00Z"),
];

export const adminRender: Record<string, () => React.ReactNode> = {
  admin: () => <AdminView overview={busy} orgs={orgs} updatedAt="2026-11-28T09:41:00Z" />,
  "admin-quiet": () => <AdminView overview={quiet} orgs={orgs.slice(4, 6)} updatedAt="2026-11-28T09:41:00Z" />,
};
