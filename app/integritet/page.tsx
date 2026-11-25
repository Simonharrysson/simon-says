import type { Metadata } from "next";
import { PublicShell } from "@/components/views/PublicShell";

export const metadata: Metadata = { title: "Integritet" };

// Plain-language privacy text for a free service. Update UPDATED when the content changes.
const UPDATED = "24 november 2026";

const processors: [string, string, string][] = [
  ["ElevenLabs", "Gör om ljudet till text under mötet.", "Loggar förfrågningar som standard; noll lagring kan kräva särskilt avtal. Behandlingen kan ske utanför EU. Ljudet skickas direkt från laptopen."],
  ["Anthropic", "Skriver anteckningarna utifrån transkriptionen.", "Får texten, inte ljudet. Behandlingen kan ske utanför EU."],
  ["Google", "Inloggning, och dokumentet i Drive hos den som startar mötet.", "Vi får bara röra filer Simon Says själv skapat. Behandlingen kan ske utanför EU."],
  ["Supabase", "Databasen: konton, föreningar, personlistor, transkriptioner och anteckningar.", "Lagras inom EU."],
  ["Vercel", "Kör webbplatsen och servern.", "Funktionerna körs i Stockholm. Vercel loggar vanliga förfrågningar (till exempel IP-adress och adress) i sina serverloggar."],
  ["Resend", "Skickar driftlarm och dagliga sammanfattningar till oss, och bara till oss.", "Innehåller inga transkriptioner."],
];

export default function PrivacyPage() {
  return (
    <PublicShell signedIn={false}>
      <article className="page page--read stack stack--5">
        <div className="stack stack--3">
          <span className="draft-flag">Utkast · uppdaterad {UPDATED} · juridisk granskning återstår</span>
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
            <a href="#grund">Rättslig grund</a>
            <a href="#rattigheter">Dina rättigheter</a>
            <a href="#radera">Radera</a>
            <a href="#kontakt">Kontakt</a>
          </nav>
        </div>

        <div className="prose">
          <h2 id="kort">Kort sagt</h2>
          <ul>
            <li>Vi sparar ingen ljudinspelning. Ljudet går direkt från laptopen till transkriberingen och blir text medan ni pratar.</li>
            <li>
              Anteckningarna hamnar i ett Google-dokument i Drive hos den som startade mötet. Alla föreningens medlemmar får
              redigeringsåtkomst till dokumentet (men kan inte dela det vidare).
            </li>
            <li>Transkriptionen och anteckningarna finns också hos oss tills ni raderar mötet eller föreningen.</li>
            <li>Föreningens medlemmar som loggar in har ett konto. Alla andra som deltar i mötet finns bara som ett namn i föreningens personlista.</li>
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
            <li>
              Möten: tider, transkription med talarnamn, anteckningar och en logg över när anteckningarna uppdaterades.
              Transkriptionen och anteckningarna sparas tills mötet eller föreningen raderas.
            </li>
            <li>
              Användningsposter: hur många sekunder ljud, hur mycket text till Claude och vad det kostade, per förening och
              dag. De används för gränsen på 20 timmar i månaden och för att stoppa missbruk.
            </li>
            <li>En logg över vilket konto som skapat vilka föreningar (för gränsen på två per person).</li>
          </ul>
          <p>
            <strong>Användningsposterna och loggen över skapade föreningar finns kvar även när föreningen raderas.</strong>{" "}
            De innehåller inga mötesinnehåll, bara siffror och id:n. De sparas i 24 månader för att förhindra missbruk.
          </p>
          <h3>Det som inte sparas</h3>
          <ul>
            <li>Ljudet från mötet.</li>
            <li>Något annat i din Google Drive.</li>
            <li>Röstavtryck. Det finns inte i den här versionen. Skulle det komma, frågar vi om uttryckligt samtycke först.</li>
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

          <h2 id="grund">Rättslig grund</h2>
          <p>Det här är vår nuvarande bedömning. En juridisk granskning återstår.</p>
          <ul>
            <li>
              <strong>Dig med konto:</strong> avtal (GDPR art. 6.1 b). Vi behöver dina uppgifter för att kunna driva tjänsten
              åt dig.
            </li>
            <li>
              <strong>Alla i rummet som transkriberas:</strong> berättigat intresse (art. 6.1 f). Föreningen har ett intresse
              av att dokumentera sina möten. Vi väger det mot er integritet genom beskedet i rummet och Paus-knappen. Du kan
              invända mot den som håller i mötet, eller mot oss.
            </li>
          </ul>

          <h2 id="rattigheter">Dina rättigheter</h2>
          <p>
            Du kan begära tillgång till uppgifter om dig, rättelse, radering, begränsning av behandlingen och dataportabilitet
            där det gäller, och du kan invända mot behandlingen. Mejla{" "}
            <a href="mailto:simon@harrysson.co">simon@harrysson.co</a>. Du kan också klaga hos
            Integritetsskyddsmyndigheten, <a href="https://www.imy.se">imy.se</a>.
          </p>

          <h2 id="overforing">Överföring utanför EU</h2>
          <p>
            När data behandlas utanför EU bygger det, där det är aktuellt, på leverantörernas standardavtalsklausuler eller
            EU–USA-ramverket för dataskydd (Data Privacy Framework).
          </p>

          <h2 id="radera">Radera</h2>
          <ul>
            <li>
              <strong>Ett möte:</strong> den som startade det, eller en admin, raderar det under föreningen. Transkription,
              anteckningar och logg försvinner hos oss.
            </li>
            <li>
              <strong>En förening:</strong> en admin raderar den längst ner på föreningens sida. Allt under den försvinner, utom användningsposterna som beskrivs ovan.
            </li>
            <li>
              <strong>Ditt konto, namn, e-postadress och den krypterade Google-nyckeln:</strong> det finns ingen funktion för
              det i tjänsten ännu. Mejla <a href="mailto:simon@harrysson.co">simon@harrysson.co</a> så raderar vi dem.
            </li>
            <li>
              <strong>Koppla bort Simon Says i Google:</strong> ta bort åtkomsten på{" "}
              <a href="https://myaccount.google.com/connections">myaccount.google.com/connections</a>. Då slutar nyckeln
              fungera.
            </li>
            <li>
              <strong>Google-dokumenten</strong> ligger kvar i Drive. De är era, och ni tar bort dem i Drive som vanligt.
              Varje medlem får redigeringsåtkomst till dokumenten för möten som startas medan hen är medlem. Tas en medlem
              bort ur föreningen, eller lämnar den, är dokument som redan delats fortfarande delade med hen tills ägaren tar
              bort delningen i Drive.
            </li>
          </ul>

          <h2 id="statussidan">Statussidan</h2>
          <p>
            Den offentliga statussidan visar antal möten som pågår, antal möten och minuter transkriberade den senaste veckan, och om tjänsten fungerar. En förening syns med namn bara om en admin kryssat
            i det i inställningarna.
          </p>

          <h2 id="kontakt">Kontakt</h2>
          <p>
            Frågor, eller vill du veta vad vi har sparat om dig? Skriv till Harrysson &amp; Company AB på{" "}
            <a href="mailto:simon@harrysson.co">simon@harrysson.co</a>.
          </p>
        </div>
      </article>
    </PublicShell>
  );
}
