import type { Overview } from "@/lib/dashboard/overview";
import type { OverviewGoal } from "@/components/views/OverviewView";

// Fictional data for the /design Översikt states. No real förening, people or content.

export const OVERVIEW_NOW = new Date("2026-11-24T18:42:00Z");

export const demoOverview: Overview = {
  meetingCount: 11,
  firstMeeting: "2026-09-08T17:00:00Z",
  lastMeeting: "2026-11-17T17:00:00Z",
  openTasks: [
    {
      key: "p:p1",
      label: "Anna Berg",
      role: "Kassör",
      tasks: [
        { key: "a1", text: "Byta bank till en med lägre avgifter för föreningskonto", due: null, since: "2026-09-22T17:00:00Z", weeks: 9, item: "Ekonomi" },
        { key: "a2", text: "Skicka fakturan för hyran av lokalen till kåren", due: "1 dec", since: "2026-11-10T17:00:00Z", weeks: 2, item: "Ekonomi" },
      ],
    },
    {
      key: "o:sekreteraren",
      label: "Sekreteraren",
      role: null,
      tasks: [{ key: "s1", text: "Lägga upp protokollen på hemsidan", due: null, since: "2026-10-13T17:00:00Z", weeks: 6, item: null }],
    },
    {
      key: "p:p2",
      label: "Erik Lund",
      role: null,
      tasks: [{ key: "e1", text: "Fråga tre företag om sponsring av vårens spelturnering", due: "15 dec", since: "2026-11-03T17:00:00Z", weeks: 3, item: "Kommande event" }],
    },
    {
      key: "none",
      label: "Utan ansvarig",
      role: null,
      tasks: [{ key: "n1", text: "Ta fram en affisch till prova-på-kvällen", due: null, since: "2026-11-17T17:00:00Z", weeks: 1, item: "Medlemsvärvning" }],
    },
  ],
  decisions: [
    { key: "d1", text: "Prova-på-kvällen hålls torsdag 4 december i Kårhusets lilla sal.", date: "2026-11-17T17:00:00Z", item: "Kommande event" },
    { key: "d2", text: "Medlemsavgiften för våren blir 100 kr.", date: "2026-11-17T17:00:00Z", item: "Ekonomi" },
    { key: "d3", text: "Hyran för förrådet höjs till 300 kr i månaden från januari.", date: "2026-11-10T17:00:00Z", item: "Ekonomi" },
    { key: "d4", text: "Spelkvällarna flyttas från tisdagar till torsdagar.", date: "2026-11-03T17:00:00Z", item: "Spelkvällar" },
    { key: "d5", text: "Föreningen ställer upp med ett bord på kårens höstmässa.", date: "2026-10-20T17:00:00Z", item: "Medlemsvärvning" },
    { key: "d6", text: "Vi köper in två nya strategispel för högst 1 200 kr.", date: "2026-10-13T17:00:00Z", item: "Ekonomi" },
    { key: "d7", text: "Nyhetsbrevet går ut första måndagen varje månad.", date: "2026-09-29T17:00:00Z", item: null },
    { key: "d8", text: "Spelturneringen i vår får ett eget budgetutrymme på 2 000 kr.", date: "2026-09-22T17:00:00Z", item: "Kommande event" },
  ],
  topics: [
    {
      label: "Ekonomi",
      meetings: 11,
      lastSeen: "2026-11-17T17:00:00Z",
      months: [
        { month: "2026-11", decisions: ["Medlemsavgiften för våren blir 100 kr.", "Hyran för förrådet höjs till 300 kr i månaden från januari."] },
        { month: "2026-10", decisions: ["Vi köper in två nya strategispel för högst 1 200 kr."] },
      ],
    },
    {
      label: "Kommande event",
      meetings: 8,
      lastSeen: "2026-11-17T17:00:00Z",
      months: [
        { month: "2026-11", decisions: ["Prova-på-kvällen hålls torsdag 4 december i Kårhusets lilla sal."] },
        { month: "2026-09", decisions: ["Spelturneringen i vår får ett eget budgetutrymme på 2 000 kr."] },
      ],
    },
    { label: "Medlemsvärvning", meetings: 6, lastSeen: "2026-11-17T17:00:00Z", months: [{ month: "2026-10", decisions: ["Föreningen ställer upp med ett bord på kårens höstmässa."] }] },
    { label: "Spelkvällar", meetings: 3, lastSeen: "2026-11-03T17:00:00Z", months: [] },
  ],
  attendance: {
    meetings: 10,
    people: [
      { personId: "p1", name: "Anna Berg", attended: 10, lastSeen: "2026-11-17T17:00:00Z" },
      { personId: "p2", name: "Erik Lund", attended: 7, lastSeen: "2026-11-17T17:00:00Z" },
      { personId: "p5", name: "Johan Ek", attended: 2, lastSeen: "2026-09-29T17:00:00Z" },
      { personId: "p3", name: "Sara Nyström", attended: 9, lastSeen: "2026-11-10T17:00:00Z" },
      { personId: "p4", name: "Simon", attended: 0, lastSeen: null },
    ],
  },
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
  lastMeeting: null,
  openTasks: [],
  decisions: [],
  topics: [],
  attendance: { meetings: 0, people: [] },
};
