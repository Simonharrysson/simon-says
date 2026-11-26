import type { SummaryEmailInput } from "@/lib/summaries/email";

// Fictional summary e-mails for the /design gallery and the screenshot script
// (emails/summary/shoot.sh). Exempelföreningen, made-up people and links.

const APP = "https://simonsays.harrysson.co";
const ORG = "00000000-0000-4000-8000-0000000000aa";
const unsubscribeHref = `${APP}/mejl?t=c2FyYUBleGVtcGVsLnNl.demo&k=meeting_summary`;

export const demoSummaryEmails: Record<"missed" | "admin" | "short", SummaryEmailInput> = {
  missed: {
    orgName: "Exempelföreningen",
    startedAt: "2026-11-24T17:00:00Z",
    recipientName: "Sara Nyström",
    missed: true,
    content: {
      decisions: [
        "Julfesten blir fredag 11 december i kårhuset, budget 4 000 kr.",
        "Medlemsavgiften höjs till 150 kr från januari.",
        "Vi söker sponsring från tre företag före jul.",
      ],
      tasks: [
        { text: "Boka DJ till julfesten", owner: "Sara", due: "fre 4 dec", doneWhen: "kontraktet är påskrivet", mine: true },
        { text: "Skicka fakturan till kåren", owner: "Kassör", due: null, mine: true },
        { text: "Skriva inbjudan till julfesten", owner: "Erik", due: "mån 30 nov", mine: false },
        { text: "Fråga Ica om sponsring", owner: "Anna", due: null, missing: ["due", "doneWhen"], mine: false },
      ],
      other: ["Lokalen på Kårallen är bokad varannan tisdag resten av terminen."],
      more: { decisions: 0, tasks: 0, other: 0 },
    },
    buttonHref: `${APP}/orgs/${ORG}#mote-demo`,
    accessNote: "Knappen öppnar mötet på föreningens sida i Simon Says. Där får du tillgång till dokumentet.",
    settingsHref: null,
    unsubscribeHref,
  },
  admin: {
    orgName: "Exempelföreningen",
    startedAt: "2026-11-24T17:00:00Z",
    recipientName: "Anna Berg",
    missed: false,
    content: {
      decisions: ["Julfesten blir fredag 11 december i kårhuset, budget 4 000 kr.", "Medlemsavgiften höjs till 150 kr från januari."],
      tasks: [
        { text: "Boka DJ till julfesten", owner: "Sara", due: "fre 4 dec", mine: false },
        { text: "Skriva inbjudan till julfesten", owner: "Erik", due: "mån 30 nov", mine: false },
      ],
      other: [],
      more: { decisions: 0, tasks: 3, other: 0 },
    },
    buttonHref: "https://docs.google.com/document/d/exempel/edit",
    accessNote: null,
    settingsHref: `${APP}/orgs/${ORG}#installningar`,
    unsubscribeHref,
  },
  short: {
    orgName: "Hook & Look Golf",
    startedAt: "2026-11-24T17:00:00Z",
    recipientName: "Johan Ek",
    missed: true,
    content: { decisions: ["Vårens första tävling blir 18 april på Vreta."], tasks: [], other: [], more: { decisions: 0, tasks: 0, other: 0 } },
    buttonHref: "https://docs.google.com/document/d/exempel/edit",
    accessNote: "Protokollet är ett Google-dokument. Kommer du inte åt det, be Anna Berg dela det med dig.",
    settingsHref: null,
    unsubscribeHref,
  },
};
