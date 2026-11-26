// The HARD fictional set for the goals eval (todo #7, after the first review): minutes that look
// like real föreningar write them. Sloppy bullets, abbreviations, half-finished sentences, no
// date in the body (only in the Doc title), goals called by different names over time WITHOUT a
// "renamed" line, an English-mixed series kept as ONE running Doc, a goal revived after being
// dropped, goals achieved but still talked about afterwards, implicit drops in slang. Every
// name is invented; nothing is real Hook & Look or LiU AI Society content.
//
// `doc` is the line as the protocol writes it; `text` is what a perfect extractor would store.

import { buildSeries, dates, type BuiltSeries, type FixtureSeries } from "./goals-fixtures";

const BLANDAREN: FixtureSeries = {
  slug: "blandaren",
  name: "Fotoklubben Bländaren",
  style: "d",
  // Every third week, Christmas break.
  dates: dates("2025-09-03", 16, 21, { 5: 14 }),
  roles: [
    { key: "ordf", title: "Ordförande", definite: "ordföranden", holders: [{ name: "Ylva Granqvist", from: 0 }] },
    {
      key: "kass",
      title: "Kassör",
      definite: "kassören",
      holders: [
        { name: "Torsten Lidén", from: 0 },
        { name: "Nova Hermansson", from: 6 },
      ],
    },
    { key: "lab", title: "Labbansvarig", definite: "labbansvarig", holders: [{ name: "Gunnar Edqvist", from: 0 }] },
    { key: "pr", title: "PR-ansvarig", definite: "PR-ansvarig", holders: [{ name: "Ebba Sjölund", from: 0 }] },
  ],
  extras: ["Malte Ekholm"],
  routine: (i) => [
    { at: i, item: "Ekonomi", kind: "report", text: "Kassören redovisade ekonomin, inget att anmärka.", doc: `{kass} - ekonomin ok, ${2100 + i * 130} på kontot` },
    ...(i % 2 === 0 ? [{ at: i, item: "Fotokvällar", kind: "task" as const, text: "Boka lokal för nästa fotokväll", doc: "{pr} bokar lokal nästa fotokväll", owner: "pr", done: i % 4 === 0 }] : []),
  ],
  goals: [
    {
      id: "blandaren-utstallning",
      status: "achieved",
      summary: "En utställning på stadsbiblioteket (vernissage i februari, sedan nedplockning: achieved but still mentioned)",
      keywords: ["utställning", "vernissage", "bibblan", "biblioteket", "utstallning"],
      tags: ["object-lives-on", "report-only"],
      events: [
        { at: 0, item: "Utställning", kind: "decision", text: "satsa på en egen utställning på stadsbiblioteket i vår", doc: "beslut: vi kör på utställning på bibblan i vår!!" },
        { at: 2, item: "Utställning", kind: "task", text: "Kontakta biblioteket om utställningsväggen", doc: "{pr} mejlar bibblan ang. väggen", owner: "pr", done: true },
        { at: 4, item: "Utställning", kind: "report", text: "Biblioteket har gett oss väggen i februari.", doc: "bibblan sa ja, vi får väggen feb" },
        { at: 7, item: "Utställning", kind: "task", text: "Beställa tryck av bilderna till utställningen", doc: "{kass} beställer tryck (ca 20 bilder) till bibblan-grejen", owner: "kass", done: true },
        { at: 9, item: "Utställning", kind: "report", text: "Vernissagen gick bra med ungefär 80 besökare.", doc: "vernissagen gick skitbra, typ 80 pers!" },
        { at: 11, item: "Utställning", kind: "task", text: "Hämta tavlorna från biblioteket", doc: "{lab} hämtar tavlorna från bibblan när den tas ner", owner: "lab", done: false },
      ],
    },
    {
      id: "blandaren-morkrum",
      status: "current",
      summary: "Ett eget mörkrum (kallas mörkrummet, labbet, framkallningsrummet)",
      keywords: ["mörkrum", "morkrum", "labbet", "framkallning"],
      tags: [],
      events: [
        { at: 1, item: "Mörkrum", kind: "report", text: "Flera vill att klubben får ett eget mörkrum.", doc: "många vill ha eget mörkrum, analogt är hett" },
        { at: 3, item: "Mörkrum", kind: "task", text: "Fråga kåren om källarrummet kan bli mörkrum", doc: "{ordf} frågar kåren om källarrummet", owner: "ordf", done: true },
        { at: 6, item: "Mörkrum", kind: "report", text: "Kåren låter oss använda källarrummet som mörkrum.", doc: "källarrummet: kåren ok!! blir labbet" },
        { at: 8, item: "Labbet", kind: "task", text: "Köpa framkallningsutrustning till labbet", doc: "{lab} köper framkallningsgrejer, budget 3000", owner: "lab", done: false },
        { at: 12, item: "Labbet", kind: "report", text: "Framkallningsrummet behöver ventilation innan det kan användas.", doc: "framkallningsrummet - ventilationen måste fixas innan vi kan" },
        { at: 15, item: "Labbet", kind: "task", text: "Ta in offert på ventilation till labbet", doc: "{kass} tar in offert vent.", owner: "kass", done: false },
      ],
    },
    {
      id: "blandaren-maraton",
      status: "stale",
      summary: "Ett fotomaraton i stan (sista gången en halv mening i november)",
      keywords: ["fotomaraton", "maraton"],
      tags: [],
      events: [
        { at: 1, item: "Fotomaraton", kind: "decision", text: "ordna ett fotomaraton i stan", doc: "beslut: fotomaraton i stan, någon gång i höst?" },
        { at: 3, item: "Fotomaraton", kind: "task", text: "Kolla med kommunen om tillstånd för fotomaraton", doc: "fotomaraton - {ordf} kollar m kommunen om", owner: "ordf", done: false },
      ],
    },
    {
      id: "blandaren-hemsida",
      status: "dropped",
      summary: "Ny hemsida (kallas hemsidan, webben, sajten; ersätts av bara Instagram i slang)",
      keywords: ["hemsida", "webben", "sajt", "sajten", "instagram", "insta"],
      tags: ["implicit"],
      events: [
        { at: 2, item: "Hemsida", kind: "decision", text: "bygga en ny hemsida", doc: "beslut: ny hemsida" },
        { at: 4, item: "Webben", kind: "task", text: "Göra ett utkast till webben", doc: "{pr} gör utkast webben (wordpress?)", owner: "pr", done: false },
        { at: 8, item: "Sajten", kind: "report", text: "Sajten läggs ner; klubben kör bara Instagram istället.", doc: "sajten: vi skiter i den, kör bara insta istället" },
      ],
    },
    {
      id: "blandaren-cirkel",
      status: "current",
      summary: "Studiecirkel i bildredigering (pausas i november, startar igen i mars)",
      keywords: ["studiecirkel", "cirkeln", "bildredigering", "lightroom"],
      tags: ["revived", "dropped-then-revived"],
      events: [
        { at: 0, item: "Studiecirkel", kind: "decision", text: "starta en studiecirkel i bildredigering", doc: "beslut: studiecirkel i lightroom/bildred." },
        { at: 2, item: "Studiecirkel", kind: "report", text: "Studiecirkeln har bara två deltagare.", doc: "cirkeln - bara 2 st kommer..." },
        { at: 3, item: "Studiecirkel", kind: "decision", text: "lägga ner studiecirkeln", doc: "beslut: vi lägger ner cirkeln, ingen idé" },
        { at: 10, item: "Studiecirkel", kind: "report", text: "Studiecirkeln i bildredigering startar igen, nu med tolv anmälda.", doc: "studiecirkeln drar igång igen!! 12 anmälda via studieförb." },
        { at: 13, item: "Studiecirkel", kind: "task", text: "Boka datorsal till studiecirkeln", doc: "{ordf} bokar datorsal t. cirkeln", owner: "ordf", done: true },
      ],
    },
    {
      id: "blandaren-swish",
      status: "achieved",
      summary: "Ta in medlemsavgiften via Swish (fungerar från oktober, bara som rapport)",
      keywords: ["swish", "medlemsavgift"],
      tags: ["report-only"],
      events: [
        { at: 0, item: "Medlemsavgift", kind: "task", text: "Skaffa Swish för medlemsavgiften", doc: "{kass} fixar swish för medl.avg.", owner: "kass", done: false },
        { at: 2, item: "Medlemsavgift", kind: "report", text: "Swish fungerar nu för medlemsavgiften.", doc: "swish funkar nu 👍" },
      ],
    },
    {
      id: "blandaren-tavling",
      status: "current",
      summary: "En fototävling för medlemmar (sista gången 2,5 månader före sista mötet)",
      keywords: ["fototävling", "tävling", "tavling"],
      tags: ["boundary"],
      events: [
        { at: 9, item: "Tävling", kind: "decision", text: "ordna en fototävling för medlemmarna med temat Vår", doc: "beslut: fototävl. för medl, tema \"Vår\"" },
        { at: 11, item: "Tävling", kind: "task", text: "Hitta en jury till fototävlingen", doc: "{ordf} hittar jury t. tävlingen", owner: "ordf", done: false },
      ],
    },
  ],
};

const KOMPASSEN: FixtureSeries = {
  slug: "kompassen",
  name: "International Students Kompassen",
  style: "e",
  runningDoc: true,
  // Every other Thursday, Christmas break.
  dates: dates("2025-09-04", 18, 14, { 7: 21 }),
  roles: [
    { key: "ordf", title: "Ordförande", definite: "ordföranden", holders: [{ name: "Priya Lindgren", from: 0 }] },
    { key: "kass", title: "Kassör", definite: "kassören", holders: [{ name: "Mateo Strand", from: 0 }] },
    {
      key: "event",
      title: "Eventansvarig",
      definite: "eventansvarig",
      holders: [
        { name: "Aiko Berg", from: 0 },
        { name: "Jonas Wallin", from: 8 },
      ],
    },
    { key: "sekr", title: "Sekreterare", definite: "sekreteraren", holders: [{ name: "Lea Holm", from: 0 }] },
  ],
  extras: ["Omar Nyström", "Freja Dahlberg"],
  routine: (i) => [{ at: i, item: "Economy", kind: "report", text: "Kassören rapporterade att ekonomin är stabil.", doc: "{kass}: budget fine, nothing new" }],
  goals: [
    {
      id: "kompassen-buddy",
      status: "current",
      summary: "A buddy programme for new international students (also called faddersystemet, the buddy thing)",
      keywords: ["buddy", "fadder", "faddersystem"],
      tags: [],
      events: [
        { at: 0, item: "Buddy programme", kind: "decision", text: "start a buddy programme for new international students", doc: "Decision: we start a buddy programme for new int'l students" },
        { at: 2, item: "Buddy programme", kind: "report", text: "35 buddies have signed up.", doc: "35 buddies signed up so far" },
        { at: 5, item: "Faddersystemet", kind: "task", text: "Matcha nya studenter med faddrar inför vårterminen", doc: "AP {sekr}: matcha nya studenter m faddrar inför VT", owner: "sekr", done: false },
        { at: 9, item: "Buddy programme", kind: "report", text: "The buddy programme matched 40 pairs for the spring term.", doc: "buddy thing: 40 pairs matched for spring" },
        { at: 13, item: "Faddersystemet", kind: "task", text: "Samla feedback från faddrarna", doc: "AP {sekr}: samla feedback fr faddrarna (forms?)", owner: "sekr", done: false },
        { at: 16, item: "Buddy programme", kind: "decision", text: "keep the buddy programme next year with a survey in August", doc: "Decision: buddy programme continues next year, survey in aug" },
      ],
    },
    {
      id: "kompassen-dinner",
      status: "achieved",
      summary: "An international dinner (held in November; photos and leftover budget talked about afterwards)",
      keywords: ["dinner", "middag"],
      tags: ["object-lives-on", "report-only"],
      events: [
        { at: 1, item: "International dinner", kind: "decision", text: "hold a big international dinner in November", doc: "Decision: big international dinner in Nov!" },
        { at: 3, item: "International dinner", kind: "task", text: "Book the student union hall for the dinner", doc: "AP {event}: book union hall for dinner", owner: "event", done: true },
        { at: 5, item: "International dinner", kind: "report", text: "The international dinner had 120 guests from 30 countries.", doc: "dinner was amazing, 120 ppl from 30 countries 🎉" },
        { at: 6, item: "International dinner", kind: "report", text: "The photos from the dinner are uploaded.", doc: "photos from the dinner uploaded to the drive" },
        { at: 8, item: "International dinner", kind: "report", text: "1 200 kr is left from the dinner budget.", doc: "leftover from dinner budget: 1200 kr, keep for spring?" },
      ],
    },
    {
      id: "kompassen-sprakcafe",
      status: "current",
      summary: "A Swedish language café (dropped in English in October, restarted in Swedish in March)",
      keywords: ["language café", "language cafe", "språkcafé", "sprakcafe", "språkcaféet", "fika"],
      tags: ["revived", "dropped-then-revived"],
      events: [
        { at: 0, item: "Language café", kind: "decision", text: "run a weekly Swedish language café", doc: "Decision: weekly swedish language café (fika incl.)" },
        { at: 2, item: "Language café", kind: "report", text: "Only three people came to the language café.", doc: "language café - only 3 ppl came, hmm" },
        { at: 3, item: "Language café", kind: "decision", text: "drop the language café, nobody shows up", doc: "Decision: we drop the language café, nobody shows up" },
        { at: 12, item: "Språkcafé", kind: "report", text: "Språkcaféet startar igen i april i en ny lokal på biblioteket.", doc: "språkcaféet startar igen i april!! ny lokal på bibblan" },
        { at: 14, item: "Språkcafé", kind: "task", text: "Göra affischer till språkcaféet", doc: "AP {event}: affischer språkcafé", owner: "event", done: true },
        { at: 17, item: "Språkcafé", kind: "report", text: "Språkcaféet har ungefär 15 deltagare varje vecka.", doc: "språkcafé ~15 ppl/week 👍" },
      ],
    },
    {
      id: "kompassen-ski",
      status: "stale",
      summary: "A ski trip to Åre (talked about in autumn, waiting for prices in December, then nothing)",
      keywords: ["ski", "åre", "skidresa"],
      tags: ["paused"],
      events: [
        { at: 2, item: "Ski trip", kind: "report", text: "Many want a ski trip to Åre in February.", doc: "lots of ppl want a ski trip to Åre in feb" },
        { at: 4, item: "Ski trip", kind: "task", text: "Ask bus companies for prices for the ski trip", doc: "AP {event}: ask bus companies for prices", owner: "event", done: false },
        { at: 7, item: "Ski trip", kind: "report", text: "The ski trip is waiting for prices from the bus companies.", doc: "ski trip - still waiting for prices from the" },
      ],
    },
    {
      id: "kompassen-union",
      status: "achieved",
      summary: "Become a recognised association of the student union (recognised in January, only as a status line)",
      keywords: ["union", "kåren", "kårförening", "recognised", "recognized"],
      tags: ["report-only"],
      events: [
        { at: 1, item: "Union recognition", kind: "decision", text: "apply to become a recognised association of the student union", doc: "Decision: apply for union recognition (kårförening)" },
        { at: 4, item: "Union recognition", kind: "task", text: "Send the statutes to the student union", doc: "AP {ordf}: send stadgar to the union", owner: "ordf", done: true },
        { at: 8, item: "Union recognition", kind: "report", text: "Kompassen is now officially recognised by the student union.", doc: "WE'RE OFFICIALLY RECOGNISED BY THE UNION NOW!!" },
      ],
    },
    {
      id: "kompassen-alumni",
      status: "current",
      summary: "Mentorship with alumni (only in action points)",
      keywords: ["alumni", "mentor", "mentorship"],
      tags: ["tasks-only"],
      events: [
        { at: 10, item: "Alumni", kind: "task", text: "Kontakta alumner som kan vara mentorer", doc: "AP {ordf}: kontakta alumner ang mentorskap", owner: "ordf", done: true },
        { at: 13, item: "Alumni", kind: "task", text: "Matcha fem studenter med alumni-mentorer", doc: "AP {sekr}: matcha 5 studenter m alumni mentors", owner: "sekr", done: false },
        { at: 16, item: "Alumni", kind: "task", text: "Plan a kick-off for the alumni mentors", doc: "AP {event}: kick-off for mentors", owner: "event", done: false },
      ],
    },
    {
      id: "kompassen-hoodies",
      status: "dropped",
      summary: "Merch hoodies (dropped in Swedish slang: too expensive this year)",
      keywords: ["hoodie", "hoodies", "merch"],
      tags: ["implicit"],
      events: [
        { at: 6, item: "Merch", kind: "decision", text: "order hoodies with the Kompassen logo", doc: "Decision: hoodies w logo!" },
        { at: 9, item: "Merch", kind: "task", text: "Ta in offert på hoodies", doc: "AP {kass}: offert hoodies", owner: "kass", done: true },
        { at: 11, item: "Merch", kind: "report", text: "Hoodiesarna blir inte av i år, de är för dyra.", doc: "hoodies: skippar dem, alldeles för dyrt i år" },
      ],
    },
  ],
};

export const HARD_SERIES: FixtureSeries[] = [BLANDAREN, KOMPASSEN];
export const hardSeries = (): BuiltSeries[] => HARD_SERIES.map(buildSeries);
