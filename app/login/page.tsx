import { signInWithGoogle } from "./actions";

export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  drive: "Du behöver ge Simon Says tillgång till filer den skapar.",
  refresh: "Google gav oss ingen nyckel för att skriva i dina dokument. Försök igen.",
  avbrutet: "Inloggningen avbröts.",
  start: "Det gick inte att starta inloggningen. Försök igen.",
  kod: "Inloggningen gick inte att slutföra. Försök igen.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ fel?: string }> }) {
  const { fel } = await searchParams;
  const message = fel ? (messages[fel] ?? messages.kod) : null;

  return (
    <main>
      <h1>Logga in på Simon Says</h1>
      {message && <p role="alert">{message}</p>}
      {fel === "drive" && (
        <p>
          När Google frågar: kryssa i rutan för att Simon Says får se, redigera och skapa de filer den själv skapar.
          Vi kommer inte åt några andra filer i din Drive.
        </p>
      )}
      <form action={signInWithGoogle}>
        <button type="submit">{message ? "Försök igen" : "Logga in med Google"}</button>
      </form>
    </main>
  );
}
