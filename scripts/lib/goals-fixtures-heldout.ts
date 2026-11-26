// HELD-OUT fictional set for the goals eval (todo #7, second review). Written after the prompts
// were frozen and never used for tuning: run once, report as is. Hard style (sloppy bullets, no
// body dates, an English-mixed running Doc, drifting names, slang drops, pauses that go quiet),
// with topics and goals that appear in no other set. Every name is invented.

import { buildSeries, dates, type BuiltSeries, type FixtureSeries } from "./goals-fixtures";

const TAKTPINNEN: FixtureSeries = {
  slug: "taktpinnen",
  name: "Studentkören Taktpinnen",
  style: "d",
  dates: dates("2025-08-28", 16, 17, { 6: 21 }),
  roles: [
    { key: "ordf", title: "Ordförande", definite: "ordföranden", holders: [{ name: "Signhild Åberg", from: 0 }] },
    { key: "kass", title: "Kassör", definite: "kassören", holders: [{ name: "Bertil Nyqvist", from: 0 }] },
    {
      key: "not",
      title: "Notansvarig",
      definite: "notansvarig",
      holders: [
        { name: "Hjalmar Rydén", from: 0 },
        { name: "Alice Forsman", from: 7 },
      ],
    },
    { key: "pr", title: "PR-ansvarig", definite: "PR-ansvarig", holders: [{ name: "Wilma Torstensson", from: 0 }] },
  ],
  extras: ["Leo Hultgren"],
  routine: (i) => [
    { at: i, item: "Ekonomi", kind: "report", text: "Kassören redovisade ekonomin.", doc: `{kass} ekonomi ok (${5400 + i * 210} kr)` },
    { at: i, item: "Rep", kind: "task", text: "Boka replokalen för nästa period", doc: "{ordf} bokar replokal nästa period", owner: "ordf", done: i % 2 === 0 },
  ],
  goals: [
    {
      id: "taktpinnen-jul",
      status: "achieved",
      summary: "Julkonsert i domkyrkan (fullsatt i december; noter samlas in efteråt)",
      keywords: ["julkonsert", "domkyrkan", "jul"],
      tags: ["object-lives-on", "report-only"],
      events: [
        { at: 0, item: "Julkonsert", kind: "decision", text: "ge en julkonsert i domkyrkan i december", doc: "beslut: julkonsert i domkyrkan dec" },
        { at: 2, item: "Julkonsert", kind: "task", text: "Boka domkyrkan för julkonserten", doc: "{ordf} ringer domkyrkan ang. datum", owner: "ordf", done: true },
        { at: 4, item: "Julkonsert", kind: "task", text: "Göra affischer till julkonserten", doc: "{pr} affischer jul", owner: "pr", done: false },
        { at: 6, item: "Julkonsert", kind: "report", text: "Julkonserten var fullsatt med ungefär 400 i publiken.", doc: "julkonserten - fullsatt!! ~400 pers" },
        { at: 7, item: "Julkonsert", kind: "task", text: "Samla in noterna från julkonserten", doc: "{not} samlar in julnoterna", owner: "not", done: false },
      ],
    },
    {
      id: "taktpinnen-tallinn",
      status: "current",
      summary: "Körresa till Tallinn (resan, körresan, Estland)",
      keywords: ["tallinn", "körresa", "korresa", "estland"],
      tags: [],
      events: [
        { at: 1, item: "Resa", kind: "report", text: "Flera vill göra en körresa till Tallinn i vår.", doc: "många sugna på körresa, tallinn?" },
        { at: 3, item: "Resa", kind: "decision", text: "åka på körresa till Tallinn i maj", doc: "beslut: tallinn i maj" },
        { at: 7, item: "Resa", kind: "task", text: "Boka färja till Tallinn", doc: "{kass} kollar färja estland", owner: "kass", done: true },
        { at: 10, item: "Resa", kind: "report", text: "32 har anmält sig till körresan.", doc: "resan: 32 anmälda" },
        { at: 14, item: "Resa", kind: "task", text: "Boka konsertlokal i Tallinn", doc: "{ordf} mejlar kyrkan i tallinn om konsert", owner: "ordf", done: false },
        { at: 15, item: "Resa", kind: "report", text: "Körresan är fullbokad och reseplanen är klar.", doc: "körresan fullbokad, plan klar" },
      ],
    },
    {
      id: "taktpinnen-klader",
      status: "dropped",
      summary: "Nya körkläder (läggs ner i slang: kör vidare med svart klädsel)",
      keywords: ["körkläder", "korklader", "klädsel", "kläder"],
      tags: ["implicit"],
      events: [
        { at: 2, item: "Körkläder", kind: "decision", text: "köpa nya enhetliga körkläder", doc: "beslut: nya körkläder, enhetligt" },
        { at: 5, item: "Körkläder", kind: "task", text: "Ta in offerter på körkläder", doc: "{kass} offerter kläder", owner: "kass", done: true },
        { at: 8, item: "Körkläder", kind: "report", text: "Inga nya körkläder köps; kören fortsätter med svart klädsel.", doc: "kläder: nä, vi kör svart som vanligt, inget köp" },
      ],
    },
    {
      id: "taktpinnen-basar",
      status: "current",
      summary: "Rekrytera fler basar",
      keywords: ["basar", "bas", "stämma", "rekryter"],
      tags: [],
      events: [
        { at: 1, item: "Rekrytering", kind: "report", text: "Kören har bara fyra basar.", doc: "bara 4 basar kvar :(" },
        { at: 4, item: "Rekrytering", kind: "decision", text: "satsa på att värva fler basar", doc: "beslut: värva basar, prova-på" },
        { at: 9, item: "Rekrytering", kind: "task", text: "Hålla en prova-på-kväll för basar", doc: "{pr} prova-på för basar", owner: "pr", done: true },
        { at: 12, item: "Rekrytering", kind: "report", text: "Tre nya basar har börjat.", doc: "3 nya basar!!" },
        { at: 15, item: "Rekrytering", kind: "task", text: "Ordna en till prova-på-kväll i höst", doc: "{pr} ny prova-på ht", owner: "pr", done: false },
      ],
    },
    {
      id: "taktpinnen-skiva",
      status: "stale",
      summary: "Spela in en EP (sista gången en halv mening i oktober)",
      keywords: ["inspelning", "spela in", "studion", "skiva"],
      tags: [],
      events: [
        { at: 1, item: "Inspelning", kind: "report", text: "Förslag att spela in en EP.", doc: "idé: spela in en EP?" },
        { at: 2, item: "Inspelning", kind: "task", text: "Höra med studion om pris för inspelning", doc: "{not} hör m studion om pris", owner: "not", done: false },
        { at: 3, item: "Inspelning", kind: "report", text: "Studion har inte svarat om inspelningen.", doc: "inspelning - studion har inte" },
      ],
    },
    {
      id: "taktpinnen-orkester",
      status: "stale",
      summary: "Samarbete med symfoniorkestern (vilar tills vidare, tas aldrig upp igen)",
      keywords: ["orkester", "symfoniorkester", "orkestersamarbete"],
      tags: ["paused"],
      events: [
        { at: 2, item: "Orkestern", kind: "report", text: "Symfoniorkestern vill göra en gemensam konsert.", doc: "orkestern vill köra gemensam konsert" },
        { at: 4, item: "Orkestern", kind: "report", text: "Orkestersamarbetet vilar tills vidare.", doc: "orkestersamarbetet vilar tills vidare" },
      ],
    },
    {
      id: "taktpinnen-korledare",
      status: "current",
      summary: "Körledarutbildning för medlemmar (läggs ner, blir av ändå med bidrag)",
      keywords: ["körledar", "korledar", "dirigent"],
      tags: ["revived", "dropped-then-revived"],
      events: [
        { at: 0, item: "Utbildning", kind: "report", text: "Några vill gå en körledarutbildning.", doc: "några vill gå körledarutb." },
        { at: 3, item: "Utbildning", kind: "decision", text: "ingen körledarutbildning i år, den är för dyr", doc: "beslut: ingen körledarutb i år, för dyrt" },
        { at: 10, item: "Utbildning", kind: "report", text: "Studieförbundet ger bidrag, så körledarutbildningen blir av ändå.", doc: "bidrag fr studieförb → körledarutb blir av ändå!" },
        { at: 13, item: "Utbildning", kind: "task", text: "Anmäla två medlemmar till körledarutbildningen", doc: "{ordf} anmäler 2 st", owner: "ordf", done: true },
      ],
    },
  ],
};

const PIXEL: FixtureSeries = {
  slug: "pixel",
  name: "E-sportföreningen Pixelvargarna",
  style: "e",
  runningDoc: true,
  dates: dates("2025-09-08", 16, 14, { 7: 21 }),
  roles: [
    { key: "ordf", title: "Ordförande", definite: "ordföranden", holders: [{ name: "Kian Mårtensson", from: 0 }] },
    { key: "kass", title: "Kassör", definite: "kassören", holders: [{ name: "Selma Grip", from: 0 }] },
    {
      key: "event",
      title: "Eventansvarig",
      definite: "eventansvarig",
      holders: [
        { name: "Theo Lund", from: 0 },
        { name: "Mira Ahlqvist", from: 8 },
      ],
    },
    { key: "tech", title: "Teknikansvarig", definite: "teknikansvarig", holders: [{ name: "Adrian Wiklund", from: 0 }] },
  ],
  extras: ["Elsa Brandt"],
  routine: (i) => [{ at: i, item: "Economy", kind: "report", text: "Kassören rapporterade att ekonomin är stabil.", doc: "{kass}: money ok" }],
  goals: [
    {
      id: "pixel-lan",
      status: "achieved",
      summary: "A LAN party in the spring (held in March; borrowed gear returned afterwards)",
      keywords: ["lan"],
      tags: ["object-lives-on", "report-only"],
      events: [
        { at: 1, item: "LAN", kind: "decision", text: "hold a LAN party in March", doc: "Decision: LAN party in march!!" },
        { at: 5, item: "LAN", kind: "task", text: "Book the sports hall for the LAN", doc: "AP {event}: book sports hall for LAN", owner: "event", done: true },
        { at: 9, item: "LAN", kind: "task", text: "Låna switchar och kablar till LAN", doc: "AP {tech}: låna switchar + kablar", owner: "tech", done: true },
        { at: 12, item: "LAN", kind: "report", text: "The LAN party had 90 attendees and went very well.", doc: "LAN was a blast, 90 ppl 🔥" },
        { at: 13, item: "LAN", kind: "task", text: "Lämna tillbaka de lånade switcharna", doc: "AP {tech}: return borrowed switches", owner: "tech", done: false },
      ],
    },
    {
      id: "pixel-bootcamp",
      status: "dropped",
      summary: "A bootcamp weekend with a pro coach (dropped in slang: way too pricey)",
      keywords: ["bootcamp", "coach", "tränare"],
      tags: ["implicit"],
      events: [
        { at: 2, item: "Bootcamp", kind: "decision", text: "arrange a bootcamp weekend with a professional coach", doc: "Decision: bootcamp weekend w a pro coach" },
        { at: 4, item: "Bootcamp", kind: "task", text: "Be om prisförslag från coacherna", doc: "AP {kass}: prisförslag coacher", owner: "kass", done: true },
        { at: 8, item: "Bootcamp", kind: "report", text: "The bootcamp is off; the coaches are far too expensive.", doc: "bootcamp: nope, way too pricey lol" },
      ],
    },
    {
      id: "pixel-room",
      status: "current",
      summary: "Our own gaming room (gaming room, spelrummet, the den)",
      keywords: ["gaming room", "spelrum", "the den", "källarrum"],
      tags: [],
      events: [
        { at: 0, item: "Gaming room", kind: "decision", text: "get our own gaming room on campus", doc: "Decision: we want our own gaming room on campus" },
        { at: 3, item: "Gaming room", kind: "task", text: "Fråga kåren om ett rum", doc: "AP {ordf}: fråga kåren om rum", owner: "ordf", done: true },
        { at: 6, item: "Spelrummet", kind: "report", text: "Kåren erbjuder ett rum i källaren som spelrum.", doc: "kåren erbjuder källarrum → spelrummet" },
        { at: 10, item: "The den", kind: "task", text: "Install the PCs in the den", doc: "AP {tech}: install PCs in the den", owner: "tech", done: false },
        { at: 14, item: "The den", kind: "report", text: "Four PCs are installed in the den; the network is missing.", doc: "den: 4 PCs in, network still missing" },
      ],
    },
    {
      id: "pixel-league",
      status: "current",
      summary: "A team in the university league (only in action points)",
      keywords: ["league", "liga", "ligalag", "tryouts"],
      tags: ["tasks-only"],
      events: [
        { at: 9, item: "League", kind: "task", text: "Anmäla ett lag till universitetsligan", doc: "AP {event}: anmäla lag t. uni-ligan", owner: "event", done: true },
        { at: 11, item: "League", kind: "task", text: "Hold tryouts for the league team", doc: "AP {event}: tryouts league team", owner: "event", done: true },
        { at: 15, item: "League", kind: "task", text: "Boka träningstider för ligalaget", doc: "AP {event}: träningstider ligalaget", owner: "event", done: false },
      ],
    },
    {
      id: "pixel-mods",
      status: "achieved",
      summary: "A Discord moderation team (up and running in November, as a status line)",
      keywords: ["discord", "moderat", "mod team", "mods"],
      tags: ["report-only"],
      events: [
        { at: 3, item: "Discord", kind: "task", text: "Recruit moderators for the Discord", doc: "AP {tech}: recruit mods for discord", owner: "tech", done: false },
        { at: 5, item: "Discord", kind: "report", text: "The Discord moderation team is up and running.", doc: "mod team is up and running 👍" },
      ],
    },
    {
      id: "pixel-stream",
      status: "stale",
      summary: "A Twitch channel for streaming (ends on a half sentence in November)",
      keywords: ["twitch", "stream", "streaming"],
      tags: [],
      events: [
        { at: 2, item: "Streaming", kind: "report", text: "Many want the association to stream on Twitch.", doc: "lots want us on twitch" },
        { at: 5, item: "Streaming", kind: "report", text: "The streaming setup is waiting for a camera.", doc: "stream setup - waiting for the cam from" },
      ],
    },
    {
      id: "pixel-girls",
      status: "current",
      summary: "A girls' gaming night (starts in April)",
      keywords: ["girls", "tjejkväll", "tjej"],
      tags: ["late-start"],
      events: [
        { at: 13, item: "Inclusion", kind: "decision", text: "start a monthly girls' gaming night", doc: "Decision: monthly girls gaming night" },
        { at: 15, item: "Inclusion", kind: "task", text: "Göra affischer till tjejkvällen", doc: "AP {event}: affischer tjejkväll", owner: "event", done: false },
      ],
    },
  ],
};

export const HELDOUT_SERIES: FixtureSeries[] = [TAKTPINNEN, PIXEL];
export const heldoutSeries = (): BuiltSeries[] => HELDOUT_SERIES.map(buildSeries);
