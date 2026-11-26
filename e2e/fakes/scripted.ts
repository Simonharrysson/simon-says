// The fixed answers of the fake Claude (claude.ts), kept free of app imports so the specs can
// read them without loading server code.

/** What the scripted notes write: the e2e specs look for these lines in the Doc fake. */
export const SCRIPTED = {
  decision: "Hackathonet blir den 14 februari",
  action: "Maila Kårallen om lokalen",
  now: "Budget för hackathonet",
  goals: [
    { title: "Fler medlemmar till våren", why: "Styrelsen vill växa inför vårens evenemang." },
    { title: "Ett hackathon i februari", why: "Det har tagits upp på flera möten." },
  ],
  names: ["Anna Berg", "Erik Lund", "Lisa Holm", "Omar Said"],
};
