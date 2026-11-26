// The summary e-mail states in the /design gallery (rendered by summary-demo.tsx; 0037).

export const summaryViews = [
  { id: "org-summary-missed", title: "Förening · Inställningar, sammanfattning till de som missade" },
  { id: "org-summary-selected", title: "Förening · Inställningar, sammanfattning till utvalda" },
  { id: "summary-email", title: "Sammanfattning · mejl, missade mötet, egna uppgifter" },
  { id: "summary-email-admin", title: "Sammanfattning · mejl till alla, admin, utan egna uppgifter" },
  { id: "summary-email-short", title: "Sammanfattning · mejl, bara beslut, utan konto" },
  { id: "unsubscribe-confirm", title: "Sammanfattning · avsluta prenumeration" },
  { id: "unsubscribe-done", title: "Sammanfattning · prenumerationen avslutad" },
  { id: "unsubscribe-invalid", title: "Sammanfattning · ogiltig länk" },
] as const;
