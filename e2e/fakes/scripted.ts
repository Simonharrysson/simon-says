// The fixed answers of the fake Claude (claude.ts), kept free of app imports so the specs can
// read them without loading server code.

/** What the scripted notes write: the e2e specs look for these lines in the Doc fake. */
export const SCRIPTED = {
  decision: "Hackathonet blir den 14 februari",
  action: "Maila Kårallen om lokalen",
  /** The scripted task is complete (Vem, När, Klart när): Avsluta asks nothing about it. */
  actionOwner: "Anna Berg",
  actionDue: "fredag",
  actionDoneWhen: "Kårallen har svarat",
  /** A förening whose name contains this also gets two tasks without När and Klart när (tasks.spec). */
  tasksOrg: "Uppgiftsföreningen",
  incomplete: ["Boka fika till nästa möte", "Skriva verksamhetsplanen"],
  now: "Budget för hackathonet",
  /** The meeting's title from the final pass (0048), shown in the förening's meeting list. */
  title: "Hackathon och lokal",
  goals: [
    { title: "Fler medlemmar till våren", why: "Styrelsen vill växa inför vårens evenemang." },
    { title: "Ett hackathon i februari", why: "Det har tagits upp på flera möten." },
  ],
  names: ["Anna Berg", "Erik Lund", "Lisa Holm", "Omar Said"],
  /** The Privat summary (0045): first recording in a context, then later ones. */
  privat: {
    summary: "Genomgång av labb 2 inför inlämningen.",
    decision: "Labb 2 lämnas in på fredag",
    firstTask: "Läsa kapitel 4 till tentan",
    nextTask: "Boka grupprum till labb 3",
    question: "Får man ha formelblad på tentan?",
  },
};
