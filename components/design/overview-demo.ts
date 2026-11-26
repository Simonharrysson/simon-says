import type { Overview } from "@/lib/dashboard/overview";
import type { OverviewGoal } from "@/components/views/OverviewView";

// Fictional data for the /design Översikt states (goals and the basis line). No real förening, people or content.

export const OVERVIEW_NOW = new Date("2026-11-24T18:42:00Z");

export const demoOverview: Overview = {
  meetingCount: 11,
  firstMeeting: "2026-09-08T17:00:00Z",
  imported: { count: 0, first: null, last: null },
};

export const demoGoals: OverviewGoal[] = [
  { title: "Fler medlemmar till våren", why: "Medlemsvärvning har stått på dagordningen vid sex möten sedan september." },
  { title: "En spelturnering i vår", why: "Turneringen har fått en egen budget och sponsring söks." },
  { title: "Ordning på föreningens ekonomi", why: "Ekonomi är uppe på varje möte: bankbyte, hyra och medlemsavgift." },
];

export const demoProposal = {
  goals: [...demoGoals, { title: "Fasta spelkvällar varje vecka", why: "Spelkvällarna har flyttats och diskuterats på tre möten." }],
  explanation: "Förslaget bygger på de punkter som kommit tillbaka flest gånger och på besluten under dem.",
};

export const emptyOverview: Overview = {
  meetingCount: 0,
  firstMeeting: null,
  imported: { count: 0, first: null, last: null },
};

/** Own meetings plus 48 imported protocols. */
export const demoOverviewWithHistory: Overview = {
  ...demoOverview,
  imported: { count: 48, first: "2024-10-08", last: "2026-06-09" },
};

/** Only imported protocols, no meeting with Simon Says yet. */
export const demoOverviewHistoryOnly: Overview = {
  ...emptyOverview,
  imported: { count: 48, first: "2024-10-08", last: "2026-06-09" },
};
