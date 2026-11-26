import type { ReactNode } from "react";
import { ContextView } from "@/components/privat/ContextView";
import { PrivatHomeView } from "@/components/privat/PrivatHomeView";
import { PrivatMeetingView } from "@/components/privat/PrivatMeetingView";
import { renderPrivatEmail, type PrivatEmailInput } from "@/lib/privat/email";

// The Privat pages and e-mail for the /design gallery (0045). Fake data, Swedish on purpose.

const noop = async () => {};
const toggle = async () => true;
const ago = (days: number, hours = 0) => new Date(Date.now() - (days * 24 + hours) * 3600_000).toISOString();

const contexts = [
  { id: "c1", name: "TDDE15", openTasks: 3, recordings: 5, lastAt: ago(1), created_at: ago(30), last_used_at: ago(1) },
  { id: "c2", name: "Exjobb", openTasks: 1, recordings: 2, lastAt: ago(4), created_at: ago(20), last_used_at: ago(4) },
  { id: "c3", name: "Övrigt", openTasks: 0, recordings: 1, lastAt: ago(12), created_at: ago(40), last_used_at: ago(12) },
];

const since = [
  { taskId: "t1", text: "Boka grupprum till labb 2", owner: null, status: "done" as const },
  { taskId: "t2", text: "Mejla läraren om formelbladet", owner: "Anna", status: "open" as const },
  { taskId: "t3", text: "Läsa kapitel 4", owner: null, status: "not_mentioned" as const },
];

const emailInput = (locale: "sv" | "en", withSince: boolean): PrivatEmailInput => ({
  locale,
  contextName: "TDDE15",
  startedAt: ago(0, 1),
  content: {
    summary: "Genomgång av labb 2 inför inlämningen. Gruppen delade upp rapporten och gick igenom tentans upplägg.",
    decisions: ["Labb 2 lämnas in på fredag", "Rapporten skrivs i LaTeX"],
    facts: ["Tentan är 14 januari, salstenta 4 h", "Formelblad tillåts"],
    tasks: [
      { text: "Skriv inledningen", owner: null, due: "torsdag" },
      { text: "Fixa figurerna", owner: "Anna", due: null },
    ],
    questions: ["Räknas labbarna in i betyget?"],
    sinceLast: withSince ? since : [],
  },
  meetingHref: "https://simonsays.example/privat/mote/m1",
  unsubscribeHref: "https://simonsays.example/mejl?t=demo",
});

function Email({ locale, withSince }: { locale: "sv" | "en"; withSince: boolean }) {
  const mail = renderPrivatEmail(emailInput(locale, withSince));
  return (
    <div className="flex flex-col gap-3 p-6">
      <p className="text-sm text-ink-2">
        <span className="font-medium text-ink">Ämne:</span> {mail.subject} <span className="text-ink-3">· {mail.preview}</span>
      </p>
      <iframe title={mail.subject} srcDoc={mail.html} className="h-[64rem] w-full rounded-md border-0 bg-board" />
    </div>
  );
}

const page = (children: ReactNode) => <div className="py-8">{children}</div>;

const tasks = [
  { id: "a", text: "Skriv inledningen (torsdag)", owner: null, done: false, meta: "från 26 nov 10.05" },
  { id: "b", text: "Fixa figurerna", owner: "Anna", done: false, meta: "från 26 nov 10.05" },
  { id: "c", text: "Plugga kapitel 5", owner: null, done: false, meta: "från 19 nov 10.10" },
];

export const privatRender: Record<string, () => ReactNode> = {
  "privat-empty": () => page(<PrivatHomeView startHref="#" contexts={[]} running={null} notice={null} />),
  "privat-home": () => page(<PrivatHomeView startHref="#" contexts={contexts} running={null} notice={null} />),
  "privat-home-running": () =>
    page(<PrivatHomeView startHref="#" contexts={contexts} running={{ href: "#", label: "TDDE15 · 26 nov 10.05" }} notice={null} />),
  "privat-context": () =>
    page(
      <ContextView
        contextId="c1"
        name="TDDE15"
        startHref="#"
        open={tasks}
        done={[{ id: "d", text: "Boka grupprum till labb 2", owner: null, done: true, meta: "från 19 nov 10.10" }]}
        log={[
          { kind: "decision", text: "Labb 2 lämnas in på fredag", meetingId: "m1", at: ago(1) },
          { kind: "fact", text: "Tentan är 14 januari, salstenta 4 h", meetingId: "m1", at: ago(1) },
          { kind: "decision", text: "Rapporten skrivs i LaTeX", meetingId: "m2", at: ago(8) },
        ]}
        people={[{ name: "Anna", count: 4 }, { name: "Erik", count: 2 }]}
        topics={[{ name: "labb 2", count: 3 }, { name: "tentan", count: 2 }]}
        meetings={[
          { id: "m1", startedAt: ago(1), line: "Genomgång av labb 2 inför inlämningen.", live: false },
          { id: "m2", startedAt: ago(8), line: "Uppstart av projektet och rollfördelning.", live: false },
        ]}
        notice={null}
        toggle={toggle}
        deleteContext={noop}
        busy={false}
      />,
    ),
  "privat-context-empty": () =>
    page(
      <ContextView contextId="c4" name="Kundmöten" startHref="#" open={[]} done={[]} log={[]} people={[]} topics={[]} meetings={[]} notice={null} toggle={toggle} deleteContext={noop} busy={false} />,
    ),
  "privat-meeting": () =>
    page(
      <PrivatMeetingView
        meetingId="m1"
        context={{ id: "c1", name: "TDDE15" }}
        startedAt={ago(0, 1)}
        status="ready"
        summary={{
          summary: emailInput("sv", true).content.summary,
          decisions: emailInput("sv", true).content.decisions,
          facts: emailInput("sv", true).content.facts,
          questions: emailInput("sv", true).content.questions,
          sinceLast: since,
        }}
        tasks={tasks.slice(0, 2)}
        docUrl={null}
        notice={null}
        toggle={toggle}
        deleteMeeting={noop}
      />,
    ),
  "privat-meeting-pending": () =>
    page(
      <PrivatMeetingView
        meetingId="m1"
        context={{ id: "c1", name: "TDDE15" }}
        startedAt={ago(0, 0)}
        status="pending"
        summary={null}
        tasks={[]}
        docUrl="#"
        notice={null}
        toggle={toggle}
        deleteMeeting={noop}
      />,
    ),
  "privat-email": () => <Email locale="sv" withSince />,
  "privat-email-en": () => <Email locale="en" withSince={false} />,
};
