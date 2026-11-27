import type { ReactNode } from "react";
import { renderBriefEmail, type BriefEmailInput } from "@/lib/brief/email";

// The Inför möten mail (0059) for the /design gallery. Fake data, Swedish on purpose.

export const briefViews = [
  { id: "brief-email", title: "Inför möten · mejl före ett kundmöte" },
  { id: "brief-email-en", title: "Inför möten · mejl på engelska, med dagordning" },
] as const;

const ref = (id: string, at: string, title: string | null = null) => ({ id, at, title, href: `https://simonsays.example/orgs/o1/mote/${id}` });

const input = (locale: "sv" | "en"): BriefEmailInput => ({
  locale,
  recipientName: "Anna Berg",
  eventTitle: locale === "sv" ? "Avstämning med Acme" : "Styrelsemöte",
  startsAt: "2026-11-27T13:00:00Z",
  groupName: locale === "sv" ? "Acme" : "Exempelföreningen",
  spaceName: locale === "sv" ? "Bolaget AB" : "Exempelföreningen",
  content: {
    last: ref("m1", "2026-11-20T09:00:00Z", "Pilot och prissättning"),
    decisions: [],
    promised: [
      { text: "Skicka offerten till Kim", owner: "Anna", mine: true, due: "fredag", dueDate: "2026-11-28", overdue: false, meeting: ref("m1", "2026-11-20T09:00:00Z") },
      { text: "Skicka användarlistan", owner: "Kim (Acme)", mine: false, due: "25 nov", dueDate: "2026-11-25", overdue: true, meeting: ref("m1", "2026-11-20T09:00:00Z") },
    ],
    open: [{ text: "Boka uppstartsmöte för piloten", owner: "Erik Lund", mine: false, due: null, dueDate: null, overdue: false, meeting: ref("m0", "2026-11-06T09:00:00Z") }],
    moreOpen: 0,
    agenda: locale === "en" ? { labels: ["Mötets öppnande", "Föregående protokoll", "Hackathon i februari", "Övrigt"], href: "#" } : null,
  },
  decisions: [
    { key: "d1", text: "Piloten startar 12 januari med tio användare", meeting: ref("m1", "2026-11-20T09:00:00Z") },
    { key: "d2", text: "Rabatten är 10 procent första året", meeting: ref("m1", "2026-11-20T09:00:00Z") },
    { key: "d3", text: "Kim är Acmes kontaktperson", meeting: ref("m0", "2026-11-06T09:00:00Z") },
  ],
  unsubscribeHref: "https://simonsays.example/mejl?t=demo&k=meeting_brief",
});

function Email({ locale }: { locale: "sv" | "en" }) {
  const mail = renderBriefEmail(input(locale));
  return (
    <div className="flex flex-col gap-3 p-6">
      <p className="text-sm text-ink-2">
        <span className="font-medium text-ink">Ämne:</span> {mail.subject} <span className="text-ink-3">· {mail.preview}</span>
      </p>
      <iframe title={mail.subject} srcDoc={mail.html} className="h-[64rem] w-full rounded-md border-0 bg-board" />
    </div>
  );
}

export const briefRender: Record<(typeof briefViews)[number]["id"], () => ReactNode> = {
  "brief-email": () => <Email locale="sv" />,
  "brief-email-en": () => <Email locale="en" />,
};
