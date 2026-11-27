import { HomeView } from "@/components/home/HomeView";
import { OrgMeetingView } from "@/components/home/OrgMeetingView";
import type { SaveTick } from "@/components/home/MyTasks";
import type { MeetingTask } from "@/lib/home/meeting";
import { stockholmDay, type MyTask, type RecentMeeting } from "@/lib/home/tasks";

// Mina uppgifter (/hem) and a förening meeting's page for the /design gallery. Fictional data,
// Swedish on purpose; dates relative to today so "Försenad" and "imorgon" always show.

export const homeViews = [
  { id: "home", title: "Hem · Mina uppgifter, tre föreningar och Privat" },
  { id: "home-ticked", title: "Hem · bockat av: Ångra, skrivet i dokumentet, bocka av i dokumentet också" },
  { id: "home-done", title: "Hem · Visa klara" },
  { id: "home-empty", title: "Hem · inga uppgifter, inte kopplad i en förening" },
  { id: "home-unlinked-two", title: "Hem · inte kopplad i två föreningar" },
  { id: "home-all-done", title: "Hem · allt klart, inga möten" },
  { id: "org-meeting", title: "Förening · ett möte: beslut och uppgifter" },
] as const;

const DAY = 86_400_000;
const today = stockholmDay(new Date());
const day = (offset: number) => stockholmDay(new Date(Date.now() + offset * DAY));
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const save: SaveTick = async (task) => ({ ok: true, doc: task.kind === "privat" ? "none" : task.itemId === "n2" ? "locked" : "written" });

const PADDEL = { spaceId: "o1", spaceName: "Paddelklubben", spaceKind: "forening" as const };
const FILM = { spaceId: "o2", spaceName: "Filmföreningen", spaceKind: "forening" as const };
const SPEL = { spaceId: "o3", spaceName: "Spelsektionen", spaceKind: "forening" as const };
const PRIVAT = { spaceId: "p", spaceName: "Privat", spaceKind: "privat" as const };

const task = (over: Partial<MyTask> & Pick<MyTask, "key" | "text" | "spaceId" | "spaceName" | "spaceKind">): MyTask => ({
  kind: over.spaceKind === "privat" ? "privat" : "note",
  meetingId: `m-${over.spaceId}`,
  itemId: over.key,
  due: null,
  dueDate: null,
  doneWhen: null,
  contextName: null,
  done: false,
  meetingAt: ago(1),
  position: 0,
  ...over,
});

const tasks: MyTask[] = [
  task({ ...PADDEL, key: "n1", text: "Ringa kommunen om bryggan", due: "måndag", dueDate: day(-3), doneWhen: "vi har ett datum för lagningen", meetingAt: ago(10) }),
  task({ ...FILM, key: "n2", text: "Boka salen till julvisningen", due: "imorgon", dueDate: day(1), doneWhen: "bokningen är bekräftad" }),
  task({ ...SPEL, key: "n3", text: "Skicka budgeten till styrelsen", due: "fredag", dueDate: day(4), doneWhen: "den ligger i Drive" }),
  task({ ...PRIVAT, key: "p1", text: "Läsa kapitel 4 inför labben", contextName: "TDDE15", meetingAt: ago(1) }),
  task({ ...PADDEL, key: "n4", text: "Ta fram en ny nyckellista", due: "till nästa möte", meetingAt: ago(3) }),
  task({ ...FILM, key: "n5", text: "Fråga Sara om projektorn", meetingAt: ago(8) }),
];
const doneTasks: MyTask[] = [
  task({ ...SPEL, key: "d1", text: "Beställa nya tärningar", done: true, meetingAt: ago(14) }),
  task({ ...PRIVAT, key: "d2", text: "Mejla handledaren", contextName: "Exjobb", done: true, meetingAt: ago(6) }),
];

const recent: RecentMeeting[] = [
  { id: "r1", ...FILM, startedAt: ago(1), title: "Budget och julvisning", decisions: 3, tasks: 5, href: "#" },
  { id: "r2", ...PRIVAT, startedAt: ago(1), title: "TDDE15", decisions: 1, tasks: 2, href: "#" },
  { id: "r3", ...PADDEL, startedAt: ago(3), title: null, decisions: 2, tasks: 4, href: "#" },
  { id: "r4", ...SPEL, startedAt: ago(7), title: "Terminsstart", decisions: 0, tasks: 0, href: "#" },
];

const docs = { "m-o1": "#", "m-o2": "#", "m-o3": "#" };
const page = (node: React.ReactNode) => <div className="py-8">{node}</div>;

const meetingTasks: MeetingTask[] = [
  { ...tasks[1], owner: "Simon", mine: true, canTick: true },
  { ...task({ ...FILM, key: "m2", text: "Göra affischen", due: "15 dec", dueDate: day(19), doneWhen: "den sitter uppe i Kårallen" }), owner: "PR-ansvarig", mine: false, canTick: false },
  { ...task({ ...FILM, key: "m3", text: "Kolla rättigheterna för filmen" }), owner: null, mine: false, canTick: false },
  { ...task({ ...FILM, key: "m4", text: "Skicka kallelsen", done: true }), owner: "Ordförande", mine: false, canTick: false },
];

export const homeRender: Record<string, () => React.ReactNode> = {
  home: () => page(<HomeView tasks={[...tasks, ...doneTasks]} recent={recent} unlinked={[]} docs={docs} today={today} save={save} />),
  "home-ticked": () =>
    page(
      <HomeView
        tasks={tasks}
        recent={recent}
        unlinked={[]}
        docs={docs}
        today={today}
        save={save}
        initialStates={{ n1: { kind: "pending" }, n3: { kind: "saved", doc: "written" }, n2: { kind: "saved", doc: "locked" } }}
      />,
    ),
  "home-done": () => page(<HomeView tasks={[...tasks, ...doneTasks]} recent={recent} unlinked={[]} docs={docs} today={today} save={save} initialShowDone />),
  "home-empty": () => page(<HomeView tasks={[]} recent={recent.slice(0, 2)} unlinked={[{ id: "o2", name: "Filmföreningen" }]} docs={{}} today={today} save={save} />),
  "home-unlinked-two": () => page(<HomeView tasks={tasks} recent={recent.slice(0, 2)} unlinked={[{ id: "o2", name: "Filmföreningen" }, { id: "o3", name: "Körföreningen" }]} docs={docs} today={today} save={save} />),
  "home-all-done": () => page(<HomeView tasks={doneTasks} recent={[]} unlinked={[]} docs={{}} today={today} save={save} />),
  "org-meeting": () =>
    page(
      <OrgMeetingView
        today={today}
        save={save}
        page={{
          org: { id: "o2", name: "Filmföreningen" },
          meeting: { id: "m-o2", startedAt: ago(1), status: "done", title: "Budget och julvisning", isTest: false },
          decisions: ["Julvisningen blir den 18 december i Kårallen.", "Budgeten för våren godkänns med 4 000 kr till filmhyra.", "Medlemsavgiften är oförändrad, 50 kr."],
          tasks: meetingTasks,
          isAdmin: false,
          docUrl: "#",
        }}
      />,
    ),
};
