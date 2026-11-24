import type { Metadata } from "next";
import { PublicShell } from "@/components/views/PublicShell";

export const metadata: Metadata = { title: "Integritet" };

// DRAFT. Structure and plain-language copy; Task 13 / Simon finalise the legal text and
// the contact address before this is relied on.

const processors: [string, string, string][] = [
  ["ElevenLabs", "Gör om ljudet till text under mötet.", "Loggar förfrågningar som standard. Ljudet skickas direkt från laptopen."],
  ["Anthropic", "Skriver anteckningarna utifrån transkriptionen.", "Får texten, inte ljudet."],
  ["Google", "Inloggning, och dokumentet i Drive hos den som startar mötet.", "Vi får bara röra filer Simon Says själv skapat."],
  ["Supabase", "Databasen: konton, föreningar, personlistor, transkriptioner och anteckningar.", "Lagras inom EU."],
  ["Vercel", "Kör webbplatsen och servern.", ""],
  ["Resend", "Skickar driftlarm och dagliga sammanfattningar till oss.", "Innehåller inga transkriptioner."],
];

export default function PrivacyPage() {
  return (
    <PublicShell signedIn={false}>
      <article className="page page--read stack stack--5">
        <div className="stack stack--3">
          <span className="draft-flag">Utkast · inte slutlig text</span>
          <h1 className="page-header__title">Integritet</h1>
          <p className="lead">
            Simon Says lyssnar på era möten. Här står vad det betyder: vad som skickas vart, vad som sparas, och hur ni
            tar bort det.
          </p>
          <nav className="toc" aria-label="Innehåll">
            <a href="#kort">Kort sagt</a>
            <a href="#i-rummet">I rummet</a>
            <a href="#sparas">Vad som sparas</a>
            <a href="#vem">Vilka som behandlar data</a>
            <a href="#radera">Radera</a>
            <a href="#kontakt">Kontakt</a>
          </nav>
        </div>

        <div className="prose">
          <h2 id="kort">Kort sagt</h2>
          <ul>
            <li>Vi sparar ingen ljudinspelning. Ljudet går direkt från laptopen till transkriberingen och blir text medan ni pratar.</li>
            <li>Anteckningarna hamnar i ett Google-dokument i Drive hos den som startade mötet.</li>
            <li>Transkriptionen och anteckningarna finns också hos oss tills ni raderar mötet eller föreningen.</li>
            <li>Bara den som startar mötet har ett konto. Övriga är namn i föreningens personlista.</li>
            <li>
              Personuppgiftsansvarig är <strong>Harrysson &amp; Company AB</strong>.
            </li>
          </ul>

          <h2 id="i-rummet">I rummet</h2>
          <p>
            Innan ett möte kan starta bekräftar den som håller i det att alla i rummet vet att mötet transkriberas och kan
            be om paus. Bekräftelsen sparas med mötet. Paus-knappen stoppar ljudet direkt; inget skickas förrän någon
            trycker Fortsätt.
          </p>
          <p>
            Föreningens admin väljer om hela transkriptionen ska delas i dokumentet (en egen flik) eller bara
            anteckningarna.
          </p>

          <h2 id="sparas">Vad som sparas</h2>
          <h3>För den som loggar in</h3>
          <ul>
            <li>Namn och e-postadress från Google.</li>
            <li>En krypterad nyckel som låter oss skriva i dokumenten Simon Says själv skapat.</li>
          </ul>
          <h3>För varje förening</h3>
          <ul>
            <li>Namn, medlemmar, inbjudningslänk och personlistan (bara namn).</li>
            <li>Möten: tider, transkription med talarnamn, anteckningar och en logg över när anteckningarna uppdaterades.</li>
            <li>Hur många minuter föreningen använt, för att hålla gränsen på 20 timmar i månaden.</li>
          </ul>
          <h3>Det som inte sparas</h3>
          <ul>
            <li>Ljudet från mötet.</li>
            <li>Något annat i din Google Drive.</li>
          </ul>

          <h2 id="vem">Vilka som behandlar data</h2>
          <table className="processor-table">
            <thead>
              <tr>
                <th scope="col">Tjänst</th>
                <th scope="col">Gör</th>
                <th scope="col">Bra att veta</th>
              </tr>
            </thead>
            <tbody>
              {processors.map(([name, what, note]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>{what}</td>
                  <td className="muted">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 id="radera">Radera</h2>
          <ul>
            <li>
              <strong>Ett möte:</strong> den som startade det, eller en admin, raderar det under föreningen. Transkription,
              anteckningar och logg försvinner hos oss.
            </li>
            <li>
              <strong>En förening:</strong> en admin raderar den längst ner på föreningens sida. Allt under den försvinner.
            </li>
            <li>
              <strong>Google-dokumenten</strong> ligger kvar i Drive. De är era, och ni tar bort dem i Drive som vanligt.
            </li>
          </ul>

          <h2 id="statussidan">Statussidan</h2>
          <p>
            Den offentliga statussidan visar hur många möten som pågår. En förening syns med namn bara om en admin kryssat
            i det i inställningarna.
          </p>

          <h2 id="kontakt">Kontakt</h2>
          <p>
            Frågor, eller vill du veta vad vi har sparat om dig? Skriv till Harrysson &amp; Company AB. (Kontaktadress
            fylls i innan texten blir slutlig.)
          </p>
        </div>
      </article>
    </PublicShell>
  );
}
