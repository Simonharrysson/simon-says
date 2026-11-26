// Every state the /design page shows. `vy=<id>` renders one alone, full page, for screenshots.

export type DesignGroup = "Grunder" | "Sidor" | "Mötet live";

export interface DesignView {
  id: string;
  title: string;
  group: DesignGroup;
}

export const designViews: DesignView[] = [
  { id: "tokens", title: "Färger och typografi", group: "Grunder" },
  { id: "primitives", title: "Komponenter", group: "Grunder" },
  { id: "login", title: "Logga in", group: "Sidor" },
  { id: "login-drive", title: "Logga in · Drive-rutan saknades", group: "Sidor" },
  { id: "login-kod", title: "Logga in · inloggningen blev inte klar", group: "Sidor" },
  { id: "orgs-empty", title: "Föreningar · tomt", group: "Sidor" },
  { id: "orgs", title: "Föreningar · med fel", group: "Sidor" },
  { id: "org-admin", title: "Förening · admin", group: "Sidor" },
  { id: "format-learn-proposing", title: "Mötesformat · läser strukturen", group: "Sidor" },
  { id: "format-learn-editor", title: "Mötesformat · förslag att godkänna", group: "Sidor" },
  { id: "format-learn-error", title: "Mötesformat · fel", group: "Sidor" },
  { id: "format-stadgar-editor", title: "Mötesformat · punkter från stadgarna", group: "Sidor" },
  { id: "org-member-empty", title: "Förening · ny medlem, tomt", group: "Sidor" },
  { id: "org-overview", title: "Förening · översikt", group: "Sidor" },
  { id: "org-overview-goals", title: "Förening · översikt, förslag på mål", group: "Sidor" },
  { id: "org-overview-limit", title: "Förening · översikt, tre förslag i dag", group: "Sidor" },
  { id: "org-overview-empty", title: "Förening · översikt, ny medlem, tomt", group: "Sidor" },
  { id: "join-out", title: "Inbjudan · utloggad", group: "Sidor" },
  { id: "join-ready", title: "Inbjudan · gå med", group: "Sidor" },
  { id: "join-invalid", title: "Inbjudan · ogiltig länk", group: "Sidor" },
  { id: "account", title: "Konto", group: "Sidor" },
  { id: "status", title: "Status · med data", group: "Sidor" },
  { id: "live-consent", title: "Före start · samtycke", group: "Mötet live" },
  { id: "live-mic-denied", title: "Före start · mikrofonen blockerad", group: "Mötet live" },
  { id: "live-agenda-suggestion", title: "Före start · förslag på dagordning", group: "Mötet live" },
  { id: "live-agenda-none", title: "Före start · ingen dagordning", group: "Mötet live" },
  { id: "live-agenda-folder", title: "Före start · mötesmappen inte öppnad", group: "Mötet live" },
  { id: "live-agenda-off", title: "Före start · Google-väljaren av", group: "Mötet live" },
  { id: "live-starting", title: "Startar", group: "Mötet live" },
  { id: "live-nameround", title: "Namnrunda", group: "Mötet live" },
  { id: "live", title: "Pågår", group: "Mötet live" },
  { id: "live-reconnecting", title: "Ansluter igen + anteckningarna efter", group: "Mötet live" },
  { id: "live-doc-paused", title: "Dokumentet pausat", group: "Mötet live" },
  { id: "live-many-warnings", title: "Flera varningar samtidigt", group: "Mötet live" },
  { id: "live-time-warning", title: "3 h 45 · varning", group: "Mötet live" },
  { id: "live-paused", title: "Pausat", group: "Mötet live" },
  { id: "live-error", title: "Transkriptionen har stannat", group: "Mötet live" },
  { id: "live-ending", title: "Avslutar", group: "Mötet live" },
  { id: "live-ended", title: "Avslutat", group: "Mötet live" },
  { id: "live-resume", title: "Fortsätt mötet", group: "Mötet live" },
];

export const lookupView = (id: string) => designViews.find((v) => v.id === id) ?? null;
