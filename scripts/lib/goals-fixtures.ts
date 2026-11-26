// Fictional protocol series for the goals-from-history eval (todo #7). Three made-up föreningar,
// 16–28 protocols each over a year, with goals that start, get achieved (sometimes only as a
// status line, never a formal decision), get dropped explicitly, go quiet (stale), get renamed and
// get revived. Never real Hook & Look or LiU AI Society content; every name is invented.
//
// Each series yields (1) the protocol text as an admin would pick it (rendered in one of three
// house styles, with people's first names in it, board members who change mid-year), (2) the
// ground-truth extraction per protocol (what a perfect extractor stores: roles, no names) and
// (3) the ground-truth goals with status, mention dates and keywords for matching. Pure and
// deterministic: the same code always gives the same series.

import type { GoalStatus, HistoryItem, HistoryMeeting } from "@/lib/history/types";

export interface FixtureRole {
  key: string;
  /** "Kassör" (owner as stored). */
  title: string;
  /** "kassören" (in running text of the ground truth). */
  definite: string;
  /** Full names; holder i holds the role from protocol index `from[i]`. */
  holders: { name: string; from: number }[];
}

export interface FixtureEvent {
  at: number;
  /** Agenda item label it sits under. */
  item: string;
  kind: "decision" | "task" | "report";
  /** Swedish text; `{ordf}` etc. is a role placeholder (a first name in the protocol, the role in the truth). */
  text: string;
  /** Hard set: the line exactly as the sloppy protocol writes it (placeholders allowed); `text` stays the clean truth. */
  doc?: string;
  owner?: string;
  done?: boolean;
}

export interface FixtureGoal {
  id: string;
  status: GoalStatus;
  /** What the goal is, for the report and the judge. */
  summary: string;
  /** Lowercase phrases; a proposed goal whose text holds one of them is this goal. */
  keywords: string[];
  /** Renamed goals: phrases of the newest name (the title should use it). */
  newNameKeywords?: string[];
  tags: ("renamed" | "revived" | "report-only" | "late-start" | "boundary" | "implicit" | "dropped-then-revived" | "paused" | "tasks-only" | "object-lives-on")[];
  events: FixtureEvent[];
}

export interface FixtureSeries {
  slug: string;
  name: string;
  /** a–c: the clean set's house styles; d: sloppy Swedish bullets; e: English-mixed bullets. */
  style: "a" | "b" | "c" | "d" | "e";
  /** Hard set: the whole series is kept in ONE running Doc (the eval splits it like the import does). */
  runningDoc?: boolean;
  dates: string[];
  roles: FixtureRole[];
  /** Other attendees (never task owners). */
  extras: string[];
  routine: (i: number) => FixtureEvent[];
  goals: FixtureGoal[];
  /** From this protocol on, the meetings are Simon Says' own (source "simonsays" in the truth history). */
  ownFrom?: number;
}

export interface FixtureProtocol {
  index: number;
  date: string;
  /** The Doc's title as the admin sees it in the Picker. */
  title: string;
  /** The Doc's text. */
  text: string;
  /** What a perfect extraction stores. */
  truth: HistoryMeeting;
  /** Goal ids mentioned in this protocol. */
  goals: string[];
}

export interface TruthGoal {
  id: string;
  status: GoalStatus;
  summary: string;
  keywords: string[];
  newNameKeywords?: string[];
  tags: FixtureGoal["tags"];
  mentions: string[];
  firstMentioned: string;
  lastMentioned: string;
}

export interface BuiltSeries {
  slug: string;
  name: string;
  protocols: FixtureProtocol[];
  goals: TruthGoal[];
  /** The current board (what `people` holds in Simon Says): former holders are NOT here. */
  people: string[];
  /** Everyone named anywhere in the series (no stored text may hold one). */
  allNames: string[];
  /** Latest meeting date. */
  lastDate: string;
  /** Agenda items of the routine lines (Ekonomi …): not graded in the extraction. */
  routineTopics: string[];
  /** The series is one running Doc: its text is every protocol's text, in order. */
  runningDoc: boolean;
}

// ---------------------------------------------------------------------------------------------
// Dates

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function dates(start: string, count: number, cadence: number, breaks: Record<number, number> = {}): string[] {
  const out: string[] = [];
  let d = start;
  for (let i = 0; i < count; i++) {
    out.push(d);
    d = addDays(d, cadence + (breaks[i] ?? 0));
  }
  return out;
}

const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
const longDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}-${iso.slice(2, 4)}`;

// ---------------------------------------------------------------------------------------------
// The three föreningar

const RUTAN: FixtureSeries = {
  slug: "rutan",
  name: "Brädspelsföreningen Rutan",
  style: "a",
  // Weekly on Tuesdays, Christmas and exam breaks.
  dates: dates("2025-09-02", 28, 7, { 14: 28, 22: 14 }),
  roles: [
    { key: "ordf", title: "Ordförande", definite: "ordföranden", holders: [{ name: "Hedvig Sandberg", from: 0 }] },
    {
      key: "kass",
      title: "Kassör",
      definite: "kassören",
      holders: [
        { name: "Ture Lindqvist", from: 0 },
        { name: "Alva Nordin", from: 15 },
      ],
    },
    { key: "sekr", title: "Sekreterare", definite: "sekreteraren", holders: [{ name: "Melker Ahlgren", from: 0 }] },
    { key: "event", title: "Eventansvarig", definite: "eventansvarig", holders: [{ name: "Signe Wikström", from: 0 }] },
  ],
  extras: ["Ebbe Holmgren", "Tyra Lund"],
  routine: (i) => [
    { at: i, item: "Ekonomi", kind: "report", text: `{kass} redovisade kassan, ${4200 + ((i * 370) % 2100)} kr på kontot.` },
    { at: i, item: "Kommande spelkvällar", kind: "task", text: "Boka lokalen till nästa spelkväll", owner: "event", done: i % 3 === 0 },
  ],
  goals: [
    {
      id: "rutan-medlemmar",
      status: "achieved",
      summary: "Nå 150 medlemmar till årsskiftet (nås i november, bara som lägesrapport)",
      keywords: ["150 medlemmar", "medlemsmål", "medlemsantal", "fler medlemmar", "medlemsvärvning", "värva"],
      tags: ["report-only"],
      events: [
        { at: 1, item: "Medlemsvärvning", kind: "decision", text: "sätta målet 150 medlemmar till årsskiftet" },
        { at: 1, item: "Medlemsvärvning", kind: "task", text: "Göra en affisch till värvningsbordet", owner: "sekr", done: false },
        { at: 3, item: "Medlemsvärvning", kind: "report", text: "Värvningsbordet på Nolle-P gav 31 nya medlemmar, vi är nu 104." },
        { at: 6, item: "Medlemsvärvning", kind: "report", text: "Medlemsantalet är uppe i 127." },
        { at: 9, item: "Medlemsvärvning", kind: "report", text: "{ordf} berättade att vi är 141 medlemmar." },
        { at: 12, item: "Medlemsvärvning", kind: "report", text: "Vi passerade 150 medlemmar i helgen, målet är nått!" },
      ],
    },
    {
      id: "rutan-spelkafe",
      status: "current",
      summary: "Ett öppet spelkafé på stadsbiblioteket en gång i månaden",
      keywords: ["spelkafé", "spelkafe", "biblioteket", "bibliotek"],
      tags: [],
      events: [
        { at: 2, item: "Spelkafé", kind: "decision", text: "undersöka om vi kan hålla ett öppet spelkafé på stadsbiblioteket varje månad" },
        { at: 2, item: "Spelkafé", kind: "task", text: "Kontakta biblioteket om lokal för spelkafé", owner: "event", done: false },
        { at: 5, item: "Spelkafé", kind: "report", text: "Biblioteket är positiva, första spelkaféet blir i oktober." },
        { at: 8, item: "Spelkafé", kind: "report", text: "Första spelkaféet hade 22 besökare." },
        { at: 8, item: "Spelkafé", kind: "decision", text: "fortsätta med spelkafé första lördagen varje månad" },
        { at: 13, item: "Spelkafé", kind: "task", text: "Ta fram ett schema för vem som håller i spelkaféet", owner: "event", done: true },
        { at: 17, item: "Spelkafé", kind: "report", text: "Januaris spelkafé hade rekordmånga besökare, 35 st." },
        { at: 21, item: "Spelkafé", kind: "task", text: "Köpa in fler barnspel till spelkaféet", owner: "kass", done: false },
        { at: 25, item: "Spelkafé", kind: "report", text: "Spelkaféet fortsätter, biblioteket vill förlänga samarbetet." },
        { at: 27, item: "Spelkafé", kind: "decision", text: "skriva ett samarbetsavtal med biblioteket om spelkaféet för hösten" },
      ],
    },
    {
      id: "rutan-forrad",
      status: "stale",
      summary: "Skaffa ett eget förråd för spelsamlingen (tystnar efter november)",
      keywords: ["förråd", "forrad", "förvaring"],
      tags: [],
      events: [
        { at: 4, item: "Förråd", kind: "report", text: "Spelsamlingen får inte plats i skåpet längre, vi behöver ett eget förråd." },
        { at: 4, item: "Förråd", kind: "task", text: "Fråga kåren om lediga förråd", owner: "ordf", done: false },
        { at: 7, item: "Förråd", kind: "report", text: "Kåren har inget ledigt förråd just nu men kan ha i vår." },
        { at: 10, item: "Förråd", kind: "task", text: "Kolla pris på att hyra förråd hos ett förvaringsföretag", owner: "kass", done: false },
      ],
    },
    {
      id: "rutan-turnering",
      status: "achieved",
      summary: "Arrangera en stor turnering: Höstturneringen, flyttad och omdöpt till Vinterturneringen, genomförd i februari",
      keywords: ["turnering", "höstturnering", "vinterturnering"],
      newNameKeywords: ["vinterturnering"],
      tags: ["renamed"],
      events: [
        { at: 3, item: "Höstturneringen", kind: "decision", text: "arrangera en Catan-turnering i november, kallad Höstturneringen" },
        { at: 5, item: "Höstturneringen", kind: "task", text: "Boka aulan till Höstturneringen", owner: "event", done: false },
        { at: 7, item: "Höstturneringen", kind: "report", text: "Aulan är fullbokad i november." },
        { at: 9, item: "Höstturneringen", kind: "decision", text: "flytta Höstturneringen till februari, den heter från och med nu Vinterturneringen" },
        { at: 11, item: "Vinterturneringen", kind: "task", text: "Boka aulan 14 februari till Vinterturneringen", owner: "event", done: true },
        { at: 16, item: "Vinterturneringen", kind: "report", text: "32 anmälda till Vinterturneringen hittills." },
        { at: 18, item: "Vinterturneringen", kind: "task", text: "Köpa priser till Vinterturneringen", owner: "kass", done: true },
        { at: 19, item: "Vinterturneringen", kind: "report", text: "Vinterturneringen genomfördes i lördags med 48 deltagare, mycket lyckat." },
      ],
    },
    {
      id: "rutan-sponsor",
      status: "dropped",
      summary: "Sponsoravtal med spelbutiken Spelhörnan (läggs ner uttryckligen i december)",
      keywords: ["sponsor", "spelhörnan", "spelbutik"],
      tags: [],
      events: [
        { at: 6, item: "Sponsring", kind: "decision", text: "söka ett sponsoravtal med spelbutiken Spelhörnan" },
        { at: 6, item: "Sponsring", kind: "task", text: "Skriva ett sponsorutskick till Spelhörnan", owner: "kass", done: false },
        { at: 8, item: "Sponsring", kind: "report", text: "Spelhörnan vill bara ge rabatt, inga pengar." },
        { at: 13, item: "Sponsring", kind: "decision", text: "lägga ner sponsorarbetet med Spelhörnan, det är inte värt tiden" },
      ],
    },
    {
      id: "rutan-essen",
      status: "current",
      summary: "Gemensam resa till spelmässan i Essen (tas upp i september, tystnar, väcks igen i mars)",
      keywords: ["essen", "spelmässa", "mässresa", "resa"],
      tags: ["revived"],
      events: [
        { at: 2, item: "Resa till Essen", kind: "report", text: "Flera medlemmar vill åka till spelmässan i Essen tillsammans." },
        { at: 4, item: "Resa till Essen", kind: "task", text: "Undersöka bussresa till Essen", owner: "event", done: false },
        { at: 22, item: "Resa till Essen", kind: "decision", text: "ta upp resan till spelmässan i Essen igen och åka i oktober" },
        { at: 22, item: "Resa till Essen", kind: "task", text: "Göra en intresseanmälan för Essen-resan", owner: "sekr", done: false },
        { at: 24, item: "Resa till Essen", kind: "report", text: "19 medlemmar har anmält intresse för Essen-resan." },
        { at: 26, item: "Resa till Essen", kind: "task", text: "Begära offert på buss till Essen", owner: "kass", done: false },
      ],
    },
    {
      id: "rutan-ungdom",
      status: "current",
      summary: "Starta spelträffar för ungdomar 13–17 år (börjar i april)",
      keywords: ["ungdom", "ungdomar", "unga"],
      tags: ["late-start"],
      events: [
        { at: 24, item: "Ungdomsverksamhet", kind: "decision", text: "starta spelträffar för ungdomar 13–17 år till hösten" },
        { at: 26, item: "Ungdomsverksamhet", kind: "task", text: "Söka bidrag från kommunen för ungdomsträffarna", owner: "kass", done: false },
        { at: 27, item: "Ungdomsverksamhet", kind: "report", text: "Fritidsgården vill samarbeta om ungdomsträffarna." },
      ],
    },
  ],
};

const STROMSNACK: FixtureSeries = {
  slug: "stromsnack",
  name: "Kajakklubben Strömsnäck",
  style: "b",
  // Every other Wednesday, Christmas break.
  dates: dates("2025-08-20", 20, 14, { 8: 14 }),
  roles: [
    {
      key: "ordf",
      title: "Ordförande",
      definite: "ordföranden",
      holders: [
        { name: "Gösta Berglund", from: 0 },
        { name: "Majken Öberg", from: 9 },
      ],
    },
    { key: "kass", title: "Kassör", definite: "kassören", holders: [{ name: "Folke Sjöberg", from: 0 }] },
    { key: "mat", title: "Materialansvarig", definite: "materialansvarig", holders: [{ name: "Rut Engström", from: 0 }] },
    { key: "utb", title: "Utbildningsansvarig", definite: "utbildningsansvarig", holders: [{ name: "Viggo Hellström", from: 0 }] },
  ],
  extras: ["Elvira Dahl"],
  routine: (i) => [
    { at: i, item: "Ekonomi", kind: "report", text: `Kassan är god, ${18000 + ((i * 910) % 5000)} kr.` },
    ...(i % 2 === 0 ? [{ at: i, item: "Material", kind: "task" as const, text: "Gå igenom flytvästarna", owner: "mat", done: i % 4 === 0 }] : []),
  ],
  goals: [
    {
      id: "stromsnack-brygga",
      status: "current",
      summary: "Bryggprojektet: ny brygga, utökat och omdöpt till Båthusprojektet i december",
      keywords: ["brygga", "bryggprojekt", "båthus", "bathus"],
      newNameKeywords: ["båthus"],
      tags: ["renamed"],
      events: [
        { at: 1, item: "Bryggprojektet", kind: "decision", text: "bygga en ny brygga vid klubbhuset till säsongen 2026" },
        { at: 2, item: "Bryggprojektet", kind: "task", text: "Ta in offerter på bryggan", owner: "mat", done: false },
        { at: 4, item: "Bryggprojektet", kind: "report", text: "Två offerter har kommit in, båda runt 120 000 kr." },
        { at: 6, item: "Bryggprojektet", kind: "task", text: "Söka bygglov för bryggan", owner: "ordf", done: true },
        { at: 8, item: "Bryggprojektet", kind: "decision", text: "bygga ut bryggprojektet med ett båthus; projektet heter från och med nu Båthusprojektet" },
        { at: 10, item: "Båthusprojektet", kind: "report", text: "Bygglovet för båthuset är inskickat." },
        { at: 13, item: "Båthusprojektet", kind: "task", text: "Planera arbetsdagar för båthuset", owner: "mat", done: false },
        { at: 16, item: "Båthusprojektet", kind: "report", text: "Bygglovet är beviljat, bygget startar i juni." },
        { at: 19, item: "Båthusprojektet", kind: "task", text: "Kalla till första arbetsdagen för båthuset", owner: "ordf", done: false },
      ],
    },
    {
      id: "stromsnack-nyborjare",
      status: "current",
      summary: "Nybörjarkurser i kajak under våren och sommaren",
      keywords: ["nybörjar", "nyborjar", "grundkurs", "kurser"],
      tags: [],
      events: [
        { at: 10, item: "Nybörjarkurser", kind: "decision", text: "hålla tre nybörjarkurser i kajak under maj och juni" },
        { at: 11, item: "Nybörjarkurser", kind: "task", text: "Hitta instruktörer till nybörjarkurserna", owner: "utb", done: true },
        { at: 14, item: "Nybörjarkurser", kind: "report", text: "Första nybörjarkursen är fullbokad." },
        { at: 17, item: "Nybörjarkurser", kind: "task", text: "Öppna anmälan till den tredje nybörjarkursen", owner: "utb", done: false },
        { at: 18, item: "Nybörjarkurser", kind: "report", text: "Första kursen är genomförd, två kurser kvar." },
      ],
    },
    {
      id: "stromsnack-bidrag",
      status: "achieved",
      summary: "Få föreningsbidrag från kommunen (beviljas i november, bara som lägesrapport)",
      keywords: ["bidrag", "kommunen", "föreningsbidrag"],
      tags: ["report-only"],
      events: [
        { at: 2, item: "Kommunalt bidrag", kind: "decision", text: "söka föreningsbidrag från kommunen" },
        { at: 2, item: "Kommunalt bidrag", kind: "task", text: "Skriva ansökan om föreningsbidrag", owner: "kass", done: false },
        { at: 4, item: "Kommunalt bidrag", kind: "task", text: "Skicka in ansökan om föreningsbidrag", owner: "kass", done: true },
        { at: 7, item: "Kommunalt bidrag", kind: "report", text: "Kommunen har beviljat 40 000 kr i föreningsbidrag." },
      ],
    },
    {
      id: "stromsnack-rundan",
      status: "stale",
      summary: "Arrangera en egen tävling, Strömsnäcksrundan (tystnar i oktober)",
      keywords: ["strömsnäcksrundan", "tävling", "rundan"],
      tags: [],
      events: [
        { at: 3, item: "Strömsnäcksrundan", kind: "report", text: "{ordf} föreslog att klubben ska arrangera en egen tävling, Strömsnäcksrundan." },
        { at: 5, item: "Strömsnäcksrundan", kind: "task", text: "Ta fram en bana för Strömsnäcksrundan", owner: "utb", done: false },
        { at: 6, item: "Strömsnäcksrundan", kind: "report", text: "Banförslaget för Strömsnäcksrundan är klart men datum saknas." },
      ],
    },
    {
      id: "stromsnack-bokning",
      status: "dropped",
      summary: "Byta till digital bokning av klubbens kajaker (avbryts uttryckligen i februari)",
      keywords: ["bokning", "bokningsapp", "digital"],
      tags: [],
      events: [
        { at: 5, item: "Digital bokning", kind: "decision", text: "testa en bokningsapp för klubbens kajaker" },
        { at: 9, item: "Digital bokning", kind: "report", text: "Testet av bokningsappen har varit krångligt, få har använt den." },
        { at: 11, item: "Digital bokning", kind: "decision", text: "avbryta bytet till bokningsappen; listan på väggen fortsätter" },
      ],
    },
    {
      id: "stromsnack-miljo",
      status: "current",
      summary: "Miljöcertifiera klubben (tas upp i augusti–september, väcks igen i april)",
      keywords: ["miljö", "miljo", "certifiering", "certifiera"],
      tags: ["revived"],
      events: [
        { at: 1, item: "Miljöarbete", kind: "report", text: "{kass} vill att klubben miljöcertifieras via förbundet." },
        { at: 3, item: "Miljöarbete", kind: "task", text: "Läsa förbundets krav för miljöcertifiering", owner: "kass", done: false },
        { at: 16, item: "Miljöarbete", kind: "decision", text: "återuppta miljöcertifieringen och ansöka före sommaren" },
        { at: 18, item: "Miljöarbete", kind: "task", text: "Fylla i ansökan om miljöcertifiering", owner: "kass", done: false },
      ],
    },
    {
      id: "stromsnack-sakerhet",
      status: "achieved",
      summary: "Alla ledare ska gå säkerhetsutbildning (klar i februari)",
      keywords: ["säkerhet", "sakerhet", "räddning", "ledare"],
      tags: [],
      events: [
        { at: 4, item: "Säkerhet", kind: "decision", text: "alla ledare ska gå säkerhetsutbildning med räddningsövning innan säsongen" },
        { at: 7, item: "Säkerhet", kind: "task", text: "Boka säkerhetsutbildning för ledarna", owner: "utb", done: true },
        { at: 10, item: "Säkerhet", kind: "report", text: "Halva ledargruppen har gått säkerhetsutbildningen." },
        { at: 12, item: "Säkerhet", kind: "decision", text: "säkerhetsutbildningen är klar, alla ledare har gått den" },
      ],
    },
  ],
};

const RIDAN: FixtureSeries = {
  slug: "ridan",
  name: "Studentteatern Ridån",
  style: "c",
  // Every other Wednesday, Christmas break.
  dates: dates("2025-09-10", 16, 14, { 6: 21 }),
  roles: [
    { key: "ordf", title: "Ordförande", definite: "ordföranden", holders: [{ name: "Ines Fredriksson", from: 0 }] },
    { key: "kass", title: "Kassör", definite: "kassören", holders: [{ name: "Lowe Bergqvist", from: 0 }] },
    {
      key: "prod",
      title: "Producent",
      definite: "producenten",
      holders: [
        { name: "Saga Lindholm", from: 0 },
        { name: "Edvin Kronberg", from: 7 },
      ],
    },
    { key: "pr", title: "PR-ansvarig", definite: "PR-ansvarig", holders: [{ name: "Tilde Ekdahl", from: 0 }] },
  ],
  extras: ["Valter Strand", "Ellen Moberg"],
  routine: (i) => [
    { at: i, item: "Ekonomi", kind: "report", text: `{kass} rapporterade att ekonomin är stabil.${i % 4 === 0 ? " Medlemsavgifterna är inbetalda." : ""}` },
  ],
  goals: [
    {
      id: "ridan-var",
      status: "achieved",
      summary: "Sätta upp en vårföreställning (premiär i april, slutsålt; bara som lägesrapport)",
      keywords: ["vårföreställning", "varforestallning", "pjäs", "premiär", "uppsättning"],
      tags: ["report-only"],
      events: [
        { at: 0, item: "Vårföreställningen", kind: "decision", text: "sätta upp en egen pjäs som vårföreställning" },
        { at: 2, item: "Vårföreställningen", kind: "task", text: "Hålla audition till vårföreställningen", owner: "prod", done: true },
        { at: 5, item: "Vårföreställningen", kind: "report", text: "Ensemblen är klar, repetitionerna börjar i januari." },
        { at: 8, item: "Vårföreställningen", kind: "task", text: "Boka teatersalen för premiären", owner: "prod", done: true },
        { at: 11, item: "Vårföreställningen", kind: "report", text: "Biljettsläppet för vårföreställningen är gjort." },
        { at: 14, item: "Vårföreställningen", kind: "report", text: "Premiären gick fantastiskt och alla fyra föreställningar blev slutsålda." },
      ],
    },
    {
      id: "ridan-turne",
      status: "stale",
      summary: "Turnera till andra studentstäder (tystnar i november)",
      keywords: ["turné", "turne", "studentstäder", "gästspel"],
      tags: [],
      events: [
        { at: 2, item: "Turné", kind: "report", text: "Idé om att turnera till andra studentstäder i höst." },
        { at: 3, item: "Turné", kind: "task", text: "Kontakta teaterföreningar i Uppsala och Lund om gästspel", owner: "pr", done: false },
        { at: 4, item: "Turné", kind: "report", text: "Lund har svarat att de är intresserade av ett gästspel." },
      ],
    },
    {
      id: "ridan-ljus",
      status: "dropped",
      summary: "Köpa en egen ljusanläggning (läggs ner i december: för dyrt, hyr istället)",
      keywords: ["ljus", "ljusanläggning", "ljusrigg"],
      tags: [],
      events: [
        { at: 4, item: "Ljusanläggning", kind: "decision", text: "undersöka att köpa en egen ljusanläggning" },
        { at: 5, item: "Ljusanläggning", kind: "task", text: "Ta in prisförslag på ljusanläggning", owner: "kass", done: true },
        { at: 6, item: "Ljusanläggning", kind: "decision", text: "inte köpa egen ljusanläggning, det är för dyrt; vi hyr ljus inför varje uppsättning" },
      ],
    },
    {
      id: "ridan-impro",
      status: "current",
      summary: "En improgrupp som sätter upp en egen improföreställning (nämns i september, väcks igen i mars)",
      keywords: ["impro", "improvisation"],
      tags: ["revived"],
      events: [
        { at: 1, item: "Improgrupp", kind: "report", text: "Några medlemmar vill starta en improgrupp." },
        { at: 12, item: "Improgrupp", kind: "decision", text: "starta improgruppen nu i vår och sätta upp en improföreställning i höst" },
        { at: 13, item: "Improgrupp", kind: "task", text: "Boka replokal för improgruppen", owner: "prod", done: true },
        { at: 15, item: "Improgrupp", kind: "report", text: "Improgruppen har haft två träningar; improföreställningen i höst planeras." },
      ],
    },
    {
      id: "ridan-rekrytering",
      status: "current",
      summary: "Fler medlemmar från andra program än de vanliga",
      keywords: ["rekryter", "medlemmar", "program", "värva"],
      tags: [],
      events: [
        { at: 3, item: "Rekrytering", kind: "decision", text: "satsa på att få fler medlemmar från andra program än teknik och ekonomi" },
        { at: 3, item: "Rekrytering", kind: "task", text: "Göra affischer till andra campus", owner: "pr", done: false },
        { at: 7, item: "Rekrytering", kind: "report", text: "Fem nya medlemmar från vårdprogrammen." },
        { at: 10, item: "Rekrytering", kind: "task", text: "Hålla en prova-på-kväll för nya medlemmar", owner: "pr", done: true },
        { at: 13, item: "Rekrytering", kind: "report", text: "Prova-på-kvällen lockade 25 personer från nya program." },
        { at: 15, item: "Rekrytering", kind: "decision", text: "fortsätta med prova-på-kvällar varje termin för att nå andra program" },
      ],
    },
    {
      id: "ridan-jubileum",
      status: "current",
      summary: "Fira föreningens 20-årsjubileum (Jubileumsfesten, omdöpt till Jubileumsgalan i mars)",
      keywords: ["jubileum", "20-år", "20 år", "gala"],
      newNameKeywords: ["jubileumsgala", "gala"],
      tags: ["renamed"],
      events: [
        { at: 5, item: "Jubileumsfesten", kind: "decision", text: "fira 20-årsjubileet med en jubileumsfest i oktober" },
        { at: 7, item: "Jubileumsfesten", kind: "task", text: "Samla kontaktuppgifter till gamla medlemmar", owner: "pr", done: false },
        { at: 10, item: "Jubileumsgalan", kind: "decision", text: "göra jubileumsfesten till en gala med föreställning; den heter från och med nu Jubileumsgalan" },
        { at: 12, item: "Jubileumsgalan", kind: "task", text: "Boka festlokal till Jubileumsgalan", owner: "kass", done: true },
        { at: 15, item: "Jubileumsgalan", kind: "report", text: "Ett trettiotal gamla medlemmar har tackat ja till Jubileumsgalan." },
      ],
    },
    {
      id: "ridan-fakt",
      status: "current",
      summary: "En workshop i scenfäktning (nämns i januari–februari, knappt inom 3 månader före sista mötet)",
      keywords: ["scenfäktning", "fäktning", "faktning"],
      tags: ["boundary"],
      events: [
        { at: 8, item: "Workshops", kind: "decision", text: "ordna en workshop i scenfäktning" },
        { at: 9, item: "Workshops", kind: "task", text: "Hitta en instruktör i scenfäktning", owner: "prod", done: false },
      ],
    },
  ],
};

// The hard one: signals that are implicit (an achievement only as a thank-you, a drop only as
// "instead we …"), a goal dropped and later revived, a goal paused and then forgotten, a goal
// that lives only in tasks, an achieved goal whose result keeps being talked about, a stale
// boundary just past 3 months, and more routine noise. The last four meetings are Simon Says'
// own (in the digest stage).
const FJALL: FixtureSeries = {
  slug: "fjall",
  name: "Friluftsföreningen Fjällrävarna",
  style: "a",
  dates: dates("2025-09-08", 18, 14, { 6: 21 }),
  ownFrom: 14,
  roles: [
    { key: "ordf", title: "Ordförande", definite: "ordföranden", holders: [{ name: "Märta Jonsson", from: 0 }] },
    {
      key: "kass",
      title: "Kassör",
      definite: "kassören",
      holders: [
        { name: "Halvar Nygren", from: 0 },
        { name: "Idun Sandström", from: 7 },
      ],
    },
    { key: "tur", title: "Turansvarig", definite: "turansvarig", holders: [{ name: "Assar Blom", from: 0 }] },
    { key: "sekr", title: "Sekreterare", definite: "sekreteraren", holders: [{ name: "Vera Lönnqvist", from: 0 }] },
  ],
  extras: ["Knut Ahlström", "Stina Malm"],
  routine: (i) => [
    // From 14 on the meetings are Simon Says' own: its notes hold decisions and tasks, no status lines.
    ...(i < 14
      ? [
          { at: i, item: "Ekonomi", kind: "report" as const, text: `{kass} gick igenom kassan; ${9000 + ((i * 640) % 4000)} kr, inga konstigheter.` },
          {
            at: i,
            item: "Turer",
            kind: "report" as const,
            text: ["Helgens dagstur till Omberg samlade 14 deltagare.", "Kvällspaddlingen ställdes in på grund av blåst.", "Vandringen i Tiveden hade 9 deltagare.", "Skidturen i Kolmården lockade 21 personer."][i % 4],
          },
        ]
      : [{ at: i, item: "Ekonomi", kind: "decision" as const, text: "godkänna kassarapporten" }]),
    ...(i % 3 === 1 ? [{ at: i, item: "Turer", kind: "task" as const, text: "Lägga ut nästa månads turer i kalendern", owner: "tur", done: true }] : []),
    ...(i === 14 || i === 16 ? [{ at: i, item: "Stugan", kind: "task" as const, text: "Kalla till städdag i stugan vid Ljungsjön", owner: "sekr", done: false }] : []),
  ],
  goals: [
    {
      id: "fjall-loppis",
      status: "achieved",
      summary: "Samla in pengar till nya tält med en loppis (lyckas: bara ett tack och en summa)",
      keywords: ["loppis", "insamling", "tältkassa", "tältkassan"],
      tags: ["implicit", "report-only"],
      events: [
        { at: 1, item: "Loppis", kind: "decision", text: "hålla en loppis i november för att samla in pengar till nya tält" },
        { at: 3, item: "Loppis", kind: "task", text: "Boka gympasalen till loppisen", owner: "sekr", done: true },
        { at: 5, item: "Loppis", kind: "report", text: "Tack till alla som jobbade på loppisen i lördags – det blev 12 400 kr till tältkassan." },
      ],
    },
    {
      id: "fjall-talt",
      status: "achieved",
      summary: "Köpa nya tält (används första gången på påskturen)",
      keywords: ["tält", "talt"],
      tags: ["implicit", "report-only"],
      events: [
        { at: 5, item: "Nya tält", kind: "decision", text: "köpa fyra nya tält för de insamlade pengarna" },
        { at: 7, item: "Nya tält", kind: "task", text: "Beställa tälten", owner: "kass", done: true },
        { at: 9, item: "Nya tält", kind: "report", text: "Tälten är beställda men leveransen är försenad." },
        { at: 12, item: "Nya tält", kind: "report", text: "De nya tälten användes för första gången på påskturen och höll tätt hela natten." },
      ],
    },
    {
      id: "fjall-abisko",
      status: "current",
      summary: "Fjällvecka i Abisko (inställd i oktober, blir av ändå i april)",
      keywords: ["abisko", "fjällvecka", "fjallvecka"],
      tags: ["revived", "dropped-then-revived"],
      events: [
        { at: 2, item: "Fjällveckan", kind: "decision", text: "planera en fjällvecka i Abisko i juni" },
        { at: 4, item: "Fjällveckan", kind: "decision", text: "ställa in fjällveckan i Abisko, för få har anmält sig" },
        { at: 13, item: "Fjällveckan", kind: "report", text: "Fjällveckan i Abisko blir av ändå: studentkåren sponsrar resan och anmälan öppnar nästa vecka." },
        { at: 15, item: "Fjällveckan", kind: "task", text: "Boka tåg till Abisko", owner: "tur", done: false },
        { at: 17, item: "Fjällveckan", kind: "decision", text: "genomföra fjällveckan med de 16 anmälda; tågen är bokade" },
      ],
    },
    {
      id: "fjall-hemsida",
      status: "stale",
      summary: "En egen hemsida (pausas till efter jul och nämns sedan aldrig mer)",
      keywords: ["hemsida", "webbplats"],
      tags: ["paused"],
      events: [
        { at: 2, item: "Hemsida", kind: "report", text: "{sekr} vill att föreningen får en egen hemsida med turkalender." },
        { at: 3, item: "Hemsida", kind: "task", text: "Ta fram ett förslag på hemsida", owner: "sekr", done: false },
        { at: 6, item: "Hemsida", kind: "report", text: "Hemsidan pausas till efter jul, ingen har tid nu." },
      ],
    },
    {
      id: "fjall-klattervagg",
      status: "dropped",
      summary: "En egen klättervägg i lokalen (ersätts av rabatt på klätterhallen: bara ett 'istället')",
      keywords: ["klättervägg", "klattervagg", "klättervägg"],
      tags: ["implicit"],
      events: [
        { at: 7, item: "Klättervägg", kind: "decision", text: "undersöka om vi kan bygga en egen klättervägg i föreningslokalen" },
        { at: 9, item: "Klättervägg", kind: "task", text: "Fråga hyresvärden om klättervägg i lokalen", owner: "ordf", done: true },
        { at: 11, item: "Klättervägg", kind: "report", text: "Istället för en egen klättervägg har vi fått rabatt för medlemmar på klätterhallen." },
      ],
    },
    {
      id: "fjall-samarbete",
      status: "stale",
      summary: "Samarbete med friluftsförbundets lokalavdelning (sista gången nämnt drygt 3 månader före sista mötet)",
      keywords: ["samarbete", "lokalavdelning", "friluftsförbund"],
      tags: ["boundary"],
      events: [
        { at: 8, item: "Samarbete", kind: "report", text: "Friluftsförbundets lokalavdelning vill samarbeta om gemensamma turer." },
        { at: 10, item: "Samarbete", kind: "task", text: "Boka ett möte med lokalavdelningen om samarbete", owner: "ordf", done: false },
      ],
    },
    {
      id: "fjall-ledare",
      status: "current",
      summary: "Utbilda fler turledare (syns bara i uppgifter)",
      keywords: ["ledarutbildning", "turledare", "ledare"],
      tags: ["tasks-only"],
      events: [
        { at: 12, item: "Turer", kind: "task", text: "Anmäla tre medlemmar till förbundets turledarutbildning", owner: "tur", done: false },
        { at: 14, item: "Turer", kind: "task", text: "Betala kursavgiften för turledarutbildningen", owner: "kass", done: true },
        { at: 16, item: "Turer", kind: "task", text: "Planera en övningstur för de nya turledarna", owner: "tur", done: false },
      ],
    },
    {
      id: "fjall-stuga",
      status: "achieved",
      summary: "Hyra en egen stuga (Projekt Fyren; stugan vid Ljungsjön hyrd i februari, och städas sedan)",
      keywords: ["stuga", "stugan", "fyren", "ljungsjön"],
      tags: ["object-lives-on"],
      events: [
        { at: 3, item: "Projekt Fyren", kind: "decision", text: "undersöka att hyra en egen stuga vid sjön, arbetsnamn Projekt Fyren" },
        { at: 6, item: "Projekt Fyren", kind: "report", text: "Två stugor har visats, den vid Ljungsjön är bäst." },
        { at: 10, item: "Projekt Fyren", kind: "decision", text: "skriva hyresavtal för stugan vid Ljungsjön från och med maj; Projekt Fyren är därmed klart" },
      ],
    },
  ],
};

export const SERIES: FixtureSeries[] = [RUTAN, STROMSNACK, RIDAN, FJALL];

// ---------------------------------------------------------------------------------------------
// Building

const firstName = (full: string) => full.split(" ")[0];

function holderAt(role: FixtureRole, i: number): string {
  let name = role.holders[0].name;
  for (const h of role.holders) if (h.from <= i) name = h.name;
  return name;
}

/** `{kass}` → the holder's first name (protocol) or the role's definite form (truth). */
function fill(series: FixtureSeries, text: string, i: number, mode: "doc" | "truth"): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => {
    const role = series.roles.find((r) => r.key === key);
    if (!role) throw new Error(`unknown role ${key}`);
    if (mode === "truth") return role.definite;
    return firstName(holderAt(role, i));
  });
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Months (30.44 days) between two ISO dates. */
export const monthsBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / (30.44 * 24 * 3600 * 1000);

/** The ground-truth goals' rule for stale: not mentioned in the STALE_MONTHS before the latest meeting. */
export const FIXTURE_STALE_MONTHS = 3;

function render(series: FixtureSeries, i: number, events: FixtureEvent[]): { title: string; text: string } {
  const date = series.dates[i];
  const present = [...series.roles.map((r) => `${holderAt(r, i)} (${r.title.toLowerCase()})`), ...series.extras.filter((_, k) => (i + k) % 2 === 0)];
  const items = [...new Set(events.map((e) => e.item))];
  const owner = (e: FixtureEvent) => (e.owner ? firstName(holderAt(series.roles.find((r) => r.key === e.owner)!, i)) : "");
  const text = (e: FixtureEvent) => fill(series, e.text, i, "doc");
  const ordf = firstName(holderAt(series.roles[0], i));
  const lines: string[] = [];

  if (series.style === "a") {
    lines.push(`Protokoll styrelsemöte ${series.name}`, `Datum: ${date}`, `Närvarande: ${present.join(", ")}`, "");
    lines.push("§1 Mötets öppnande", `${ordf} öppnade mötet.`, "", "§2 Föregående protokoll", "Lades till handlingarna.", "");
    items.forEach((label, k) => {
      lines.push(`§${k + 3} ${label}`);
      for (const e of events.filter((x) => x.item === label)) {
        if (e.kind === "report") lines.push(text(e));
        else if (e.kind === "decision") lines.push(`Beslut: att ${text(e)}.`);
        else lines.push(`– ${owner(e)} ansvarar för att ${text(e).charAt(0).toLowerCase()}${text(e).slice(1)}${e.done ? " (klart)" : ""}.`);
      }
      lines.push("");
    });
    lines.push(`§${items.length + 3} Övrigt`, "Inget.", "", `§${items.length + 4} Mötets avslutande`, `${ordf} avslutade mötet.`);
    return { title: `Protokoll ${date}`, text: lines.join("\n") };
  }

  if (series.style === "b") {
    lines.push(`Styrelsemöte ${longDate(date)}`, series.name, "", `Närvarande: ${present.map((p) => p.replace(/ \(.*\)$/, "")).join(", ")}`, "");
    lines.push("1. Val av justerare", "Mötet valde en justerare.", "");
    items.forEach((label, k) => {
      lines.push(`${k + 2}. ${label}`);
      for (const e of events.filter((x) => x.item === label && x.kind !== "task")) {
        lines.push(e.kind === "decision" ? `Mötet beslutade att ${text(e)}.` : text(e));
      }
      if (!events.some((x) => x.item === label && x.kind !== "task")) lines.push("Se åtgärdslistan.");
      lines.push("");
    });
    lines.push("Åtgärdslista");
    for (const e of events.filter((x) => x.kind === "task")) lines.push(`- ${text(e)} — ${owner(e)}${e.done ? " (klart)" : ""}`);
    lines.push("", "Vid protokollet: " + firstName(holderAt(series.roles[2], i)));
    return { title: `Styrelsemöte ${longDate(date)}`, text: lines.join("\n") };
  }

  const line = (e: FixtureEvent) => (e.doc ? fill(series, e.doc, i, "doc") : null);

  if (series.style === "d") {
    // Sloppy Swedish: lower-case item labels with a colon, bullets, abbreviations, NO date in the body (only in the Doc title).
    lines.push(`närv: ${present.map((p) => firstName(p)).slice(0, 4).join(", ")}${i % 3 === 0 ? " + 2 nya" : ""}`, "");
    for (const label of items) {
      lines.push(`${label.toLowerCase()}:`);
      for (const e of events.filter((x) => x.item === label)) {
        const raw = line(e);
        if (raw) lines.push(`- ${raw}`);
        else if (e.kind === "report") lines.push(`- ${text(e)}`);
        else if (e.kind === "decision") lines.push(`- beslut: ${text(e)}`);
        else lines.push(`- ${owner(e)} ${text(e).charAt(0).toLowerCase()}${text(e).slice(1)}${e.done ? " (klart)" : ""}`);
      }
      lines.push("");
    }
    lines.push("övr: -");
    return { title: `${series.name.split(" ").at(-1)} mtg ${shortDate(date)}`, text: lines.join("\n") };
  }

  if (series.style === "e") {
    // English-mixed, as an international association writes: every meeting starts with a dated heading (a running Doc).
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const heading = `Board meeting ${Number(date.slice(8, 10))} ${MON[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    lines.push(heading, `Present: ${present.map((p) => firstName(p)).join(", ")}`, "");
    for (const label of items) {
      lines.push(`* ${label}`);
      for (const e of events.filter((x) => x.item === label)) {
        const raw = line(e);
        if (raw) lines.push(`  - ${raw}`);
        else if (e.kind === "report") lines.push(`  - ${text(e)}`);
        else if (e.kind === "decision") lines.push(`  - ${i % 2 ? "Beslut" : "Decision"}: ${text(e)}`);
        else lines.push(`  - AP ${owner(e)}: ${text(e)}${e.done ? " (done)" : ""}`);
      }
    }
    lines.push("", "AOB: nothing");
    return { title: `${series.name} – board minutes`, text: lines.join("\n") };
  }

  lines.push(`Ridån styrelsemöte ${shortDate(date)}`, "", `Närv: ${present.map((p) => firstName(p)).join(", ")}`, "");
  for (const label of items) {
    lines.push(label.toUpperCase());
    for (const e of events.filter((x) => x.item === label)) {
      if (e.kind === "report") lines.push(text(e));
      else if (e.kind === "decision") lines.push(`Beslutades: ${text(e)}.`);
      else lines.push(`ATT GÖRA: ${owner(e)}: ${text(e)}${e.done ? " ✓" : ""}`);
    }
    lines.push("");
  }
  lines.push("ÖVRIGT", "Nästa möte om två veckor.");
  return { title: `Ridån styrelsemöte ${shortDate(date)}`, text: lines.join("\n") };
}

function truthItems(series: FixtureSeries, i: number, events: FixtureEvent[]): HistoryItem[] {
  const topics = [...new Set(events.map((e) => e.item))];
  const roleTitle = (key?: string) => (key ? series.roles.find((r) => r.key === key)!.title : null);
  return [
    ...topics.map((t) => ({ kind: "topic" as const, text: t, topic: null, owner: null, done: null })),
    ...events.map((e) => ({
      kind: e.kind,
      text: capital(fill(series, e.text, i, "truth")),
      topic: e.item,
      owner: e.kind === "task" ? roleTitle(e.owner) : null,
      done: e.kind === "task" ? (e.done ?? false) : null,
    })),
  ];
}

export function buildSeries(series: FixtureSeries): BuiltSeries {
  const protocols: FixtureProtocol[] = series.dates.map((date, i) => {
    const goalEvents = series.goals.flatMap((g) => g.events.filter((e) => e.at === i).map((e) => ({ e, id: g.id })));
    // Routine first (Ekonomi …), then the goals' items in goal order.
    const events = [...series.routine(i), ...goalEvents.map((x) => x.e)];
    const { title, text } = render(series, i, events);
    return {
      index: i,
      date,
      title,
      text,
      truth: { date, source: series.ownFrom !== undefined && i >= series.ownFrom ? "simonsays" : "import", items: truthItems(series, i, events) },
      goals: [...new Set(goalEvents.map((x) => x.id))],
    };
  });
  const lastDate = series.dates.at(-1)!;
  const goals: TruthGoal[] = series.goals.map((g) => {
    const mentions = [...new Set(g.events.map((e) => series.dates[e.at]))].sort();
    const last = mentions.at(-1)!;
    // Self-check: the stated status agrees with the stale rule.
    const quiet = monthsBetween(last, lastDate) > FIXTURE_STALE_MONTHS;
    if ((g.status === "current" && quiet) || (g.status === "stale" && !quiet)) {
      throw new Error(`fixture ${g.id}: status ${g.status} but last mention ${last} vs ${lastDate}`);
    }
    return {
      id: g.id,
      status: g.status,
      summary: g.summary,
      keywords: g.keywords,
      ...(g.newNameKeywords ? { newNameKeywords: g.newNameKeywords } : {}),
      tags: g.tags,
      mentions,
      firstMentioned: mentions[0],
      lastMentioned: last,
    };
  });
  const lastIdx = series.dates.length - 1;
  return {
    slug: series.slug,
    name: series.name,
    protocols,
    goals,
    people: series.roles.map((r) => holderAt(r, lastIdx)),
    allNames: [...new Set([...series.roles.flatMap((r) => r.holders.map((h) => h.name)), ...series.extras])],
    lastDate,
    routineTopics: [...new Set(series.dates.flatMap((_, i) => series.routine(i).map((e) => e.item)))],
    runningDoc: Boolean(series.runningDoc),
  };
}

/** The clean set (4 föreningar). The hard set is in goals-fixtures-hard.ts. */
export const allSeries = (): BuiltSeries[] => SERIES.map(buildSeries);
