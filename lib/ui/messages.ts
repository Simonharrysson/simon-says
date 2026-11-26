// Every `?fel=` / `?klart=` code the server actions and callback redirect with, mapped to
// Swedish copy. Codes are produced in app/login/actions.ts, app/auth/callback/route.ts and
// app/(app)/orgs/actions.ts; keep them in sync.

export type Notice = { tone: "danger" | "success"; title?: string; text: string };

export const loginErrors: Record<string, { title: string; text: string }> = {
  drive: {
    title: "Kryssa i rutan för Google Drive",
    text: "Rutan för Google Drive var inte ikryssad. Utan den kan vi inte skapa mötesdokumentet i din Drive. Vi ser bara de filer Simon Says själv skapar. Din inbjudan ligger kvar.",
  },
  refresh: {
    title: "Google skickade ingen nyckel",
    text: "Vi fick inte behörighet att skriva i dina dokument när du inte är vid datorn. Logga in igen så brukar det lösa sig.",
  },
  avbrutet: { title: "Inloggningen avbröts", text: "Inget hände. Du kan försöka igen när du vill." },
  start: { title: "Inloggningen kunde inte starta", text: "Något gick fel hos oss eller hos Google. Försök igen om en liten stund." },
  kod: { title: "Inloggningen blev inte klar", text: "Google och vi kom inte överens den här gången. Försök igen." },
};

export function loginError(code: string | undefined) {
  if (!code) return null;
  return loginErrors[code] ?? loginErrors.kod;
}

const orgsNotices: Record<string, Notice> = {
  limit: { tone: "danger", text: "Du kan skapa högst två föreningar. Be någon annan skapa den, eller radera en du inte använder." },
  invalid: { tone: "danger", text: "Ange ett namn (högst 100 tecken)." },
  inbjudan: { tone: "danger", title: "Inbjudningslänken gäller inte längre", text: "Be den som bjöd in dig om en ny länk." },
  raderad: { tone: "success", text: "Föreningen är raderad. Google-dokumenten ligger kvar i Drive." },
  lamnat: { tone: "success", text: "Du har lämnat föreningen. Dokument som redan delats med dig ligger kvar i din Drive." },
};

const orgNotices: Record<string, Notice> = {
  namn: { tone: "danger", text: "Ange ett namn (högst 100 tecken)." },
  personnamn: {
    tone: "danger",
    text: "Det namnet går inte att använda. Ett personnamn får bara ha bokstäver, mellanslag, bindestreck, punkt och apostrof, högst fyra ord och 60 tecken.",
  },
  rollnamn: {
    tone: "danger",
    text: "Den rollen går inte att använda. En roll får bara ha bokstäver, siffror, mellanslag och tecknen & / - . ', högst fyra ord och 40 tecken.",
  },
  "roll-admin": { tone: "danger", text: "Bara en admin kan ändra roller." },
  "mote-forbidden": { tone: "danger", text: "Bara den som startade mötet eller en admin kan radera det." },
  "mote-not_found": { tone: "danger", text: "Mötet finns inte längre." },
  "mote-active": { tone: "danger", text: "Avsluta mötet innan du raderar det." },
  "org-active": { tone: "danger", text: "Ett möte pågår. Avsluta det innan du raderar föreningen." },
  "org-name_mismatch": {
    tone: "danger",
    text: "Namnet stämde inte. Skriv föreningens namn exakt för att radera den.",
  },
  "org-forbidden": { tone: "danger", text: "Bara admins kan radera föreningen." },
  "org-not_found": { tone: "danger", text: "Föreningen finns inte längre." },
  mote: { tone: "success", text: "Mötet är raderat. Google-dokumentet ligger kvar i Drive." },
  medlem: { tone: "success", text: "Medlemmen är borttagen. Mötesdokument som redan delats med hen är fortfarande delade." },
  "medlem-last_admin": {
    tone: "danger",
    text: "Föreningen måste ha kvar minst en admin, så den enda admin kan inte lämna. Radera föreningen i stället om den inte ska användas längre.",
  },
  "medlem-not_member": { tone: "danger", text: "Personen är inte medlem längre." },
  "medlem-forbidden": { tone: "danger", text: "Bara admins kan ta bort medlemmar." },
  "medlem-not_found": { tone: "danger", text: "Föreningen finns inte längre." },
};

function pick(map: Record<string, Notice>, fel?: string, klart?: string): Notice | null {
  return (fel && map[fel]) || (klart && map[klart]) || null;
}

export const orgsNotice = (fel?: string, klart?: string) => pick(orgsNotices, fel, klart);
export const orgNotice = (fel?: string, klart?: string) => pick(orgNotices, fel, klart);
