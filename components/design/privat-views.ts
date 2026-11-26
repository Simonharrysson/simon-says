// The Privat states in the /design gallery (rendered by privat-demo.tsx and DesignGallery; 0045).

export const privatViews = [
  { id: "privat-empty", title: "Privat · tomt, första besöket" },
  { id: "privat-home", title: "Privat · sammanhang med öppna uppgifter" },
  { id: "privat-home-running", title: "Privat · en inspelning pågår" },
  { id: "privat-context", title: "Privat · sammanhang: uppgifter, beslut, återkommande, inspelningar" },
  { id: "privat-context-empty", title: "Privat · nytt sammanhang utan inspelningar" },
  { id: "privat-meeting", title: "Privat · inspelning med sammanfattning och Sedan sist" },
  { id: "privat-meeting-pending", title: "Privat · inspelning, sammanfattningen kommer strax" },
  { id: "privat-email", title: "Privat · sammanfattningsmejl med Sedan sist" },
  { id: "privat-email-en", title: "Privat · sammanfattningsmejl på engelska, första gången" },
] as const;

export const privatLiveViews = [
  { id: "live-privat-consent", title: "Före start · Privat, välj sammanhang" },
  { id: "live-privat-first", title: "Före start · Privat, första inspelningen" },
  { id: "live-privat-ended", title: "Efter · Privat, inspelningen är klar" },
] as const;
