import type { Metadata } from "next";
import { PublicShell } from "@/components/views/PublicShell";

export const metadata: Metadata = { title: "Integritet" };

// Plain-language privacy text for a free service. Update UPDATED when the content changes.
const UPDATED = "26 november 2026";

const processors: [string, string, string][] = [
  ["ElevenLabs", "Gör om ljudet till text under mötet.", "Loggar förfrågningar som standard; noll lagring kan kräva särskilt avtal. Behandlingen kan ske utanför EU. Ljudet skickas direkt från laptopen."],
  ["Anthropic", "Skriver anteckningarna utifrån transkriptionen.", "Får texten, inte ljudet. Behandlingen kan ske utanför EU."],
  ["Google", "Inloggning, och dokumentet i Drive hos den som startar mötet.", "Vi får bara röra filer Simon Says själv skapat eller som du har valt. Undantag: en admin som läser in gamla protokoll kan ge läsrättighet till sin Drive (se Vad som sparas). Behandlingen kan ske utanför EU."],
  ["Supabase", "Databasen: konton, föreningar, personlistor, transkriptioner och anteckningar.", "Lagras inom EU."],
  ["Vercel", "Kör webbplatsen och servern.", "Funktionerna körs i Stockholm. Vercel loggar vanliga förfrågningar (till exempel IP-adress och adress) i sina serverloggar."],
  ["Resend", "Skickar driftlarm och dagliga sammanfattningar till oss, och inbjudningar som en admin skickar till de adresser hen skriver in.", "Innehåller inga transkriptioner."],
];

export default function PrivacyPage() {
  return (
    <PublicShell signedIn={false}>
      <article className="mx-auto w-full px-gutter max-w-[46rem] flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-dashed border-red px-[0.65rem] py-1 text-xs font-semibold text-red">Utkast · uppdaterad {UPDATED} · juridisk granskning återstår</span>
          <h1 className="text-2xl wrap-anywhere">Integritet</h1>
          <p className="max-w-[38rem] text-lg text-ink-2">
            Simon Says lyssnar på era möten. Här står vad det betyder: vad som skickas vart, vad som sparas, och hur ni
            tar bort det.
          </p>
          <nav className="flex flex-wrap gap-2 text-sm [&_a]:rounded-md [&_a]:bg-sunk [&_a]:px-[0.7rem] [&_a]:py-[0.3rem] [&_a]:text-ink-2 [&_a]:no-underline [&_a:hover]:text-ink" aria-label="Innehåll">
            <a href="#kort">Kort sagt</a>
            <a href="#i-rummet">I rummet</a>
            <a href="#sparas">Vad som sparas</a>
            <a href="#mejl">Mejl</a>
            <a href="#vem">Vilka som behandlar data</a>
            <a href="#grund">Rättslig grund</a>
            <a href="#rattigheter">Dina rättigheter</a>
            <a href="#radera">Radera</a>
            <a href="#kontakt">Kontakt</a>
          </nav>
        </div>

        <div className="flex max-w-[68ch] flex-col gap-4 [&_h2]:mt-8 [&_h2]:text-xl [&_h3]:mt-3 [&_h3]:text-lg [&_li]:marker:text-ink-3 [&_ul]:flex [&_ul]:list-dash [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5">
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
              E-postadresser som en admin skriver in för att bjuda in någon används bara för att skicka inbjudan. De sparas
              med när den skickades och om personen har gått med, tills föreningen raderas.
              Inbjudan visar adminens namn, och svar på mejlet går till adminens inloggningsadress (Reply-To), så den som
              bjuds in ser den adressen.
            </li>
            <li>
              Möten: tider, transkription med talarnamn, anteckningar och en logg över när anteckningarna uppdaterades.
              Transkriptionen och anteckningarna sparas tills mötet eller föreningen raderas.
            </li>
            <li>
              Användningsposter: hur många sekunder ljud, hur mycket text till Claude och vad det kostade, per förening och
              dag. De används för gränsen på 20 timmar i månaden och för att stoppa missbruk.
            </li>
            <li>En logg över vilket konto som skapat vilka föreningar (för gränsen på två per person).</li>
            <li>
              För fliken Översikt: rubrikerna på dagordningens punkter (utan namn) och de mål som föreningens admin har
              godkänt. Rubrikerna försvinner med mötet, målen med föreningen.
            </li>
            <li>
              Gamla protokoll som admin väljer att läsa in: texten skickas till Anthropic (Claude), som plockar ut datum,
              beslut, uppgifter (med roll, inte namn) och korta lägesrader. Bara de raderna sparas, aldrig dokumentets text;
              admin kan ta bort dem när som helst och de försvinner med föreningen.
            </li>
            <li>
              Frivilligt, bara för admin och bara för att läsa in gamla protokoll: admin kan ge Simon Says läsrättighet till sin
              Google Drive. Den används för att visa adminens mappar och namnen på dokumenten i de mappar admin väljer; bara de
              protokoll admin kryssar i öppnas. Mappar och dokumentnamn sparas inte. Nyckeln för läsrättigheten sparas
              krypterad och separat från inloggningens, används bara för inläsningen och raderas automatiskt efter 24
              timmar; admin kan också ta bort den direkt.
            </li>
          </ul>
          <p>
            <strong>Användningsposterna och loggen över skapade föreningar finns kvar även när föreningen raderas.</strong>{" "}
            De innehåller inga mötesinnehåll, bara siffror och id:n. Användningsposterna sparas så länge tjänsten drivs, för att förhindra missbruk av den gratis tjänsten och för att kunna följa kostnaden över tid. När en förening raderas finns bara dess id kvar i posterna, inte namnet. Loggen över skapade föreningar sparas för att kunna hålla gränsen på två föreningar per person.
          </p>
          <h3>Det som inte sparas</h3>
          <ul>
            <li>Ljudet från mötet.</li>
            <li>Något annat i din Google Drive, inte heller namnen på mappar och dokument som visas när admin läser in gamla protokoll.</li>
            <li>Röstavtryck. Det finns inte i den här versionen. Skulle det komma, frågar vi om uttryckligt samtycke först.</li>
          </ul>

          <h2 id="mejl">Mejl</h2>
          <p>
            Du bestämmer vilka mejl Simon Says skickar till dig. Under Konto kan du stänga av varje sorts mejl för sig, eller
            välja Inga mejl alls. Längst ner i varje mejl finns en länk till samma val som fungerar utan inloggning, även om du
            inte har något konto. Vi sparar bara dina val (och, om du saknar konto, adressen de gäller) så länge tjänsten
            drivs, så att ett nej fortsätter att gälla. Mejla oss om du vill att vi raderar dem.
          </p>

          <h2 id="vem">Vilka som behandlar data</h2>
          <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-line [&_td]:py-3 [&_td]:pr-3 [&_td]:text-left [&_td]:align-top [&_th]:border-b [&_th]:border-line [&_th]:py-3 [&_th]:pr-3 [&_th]:text-left [&_th]:align-top [&_th]:text-xs [&_th]:font-semibold [&_th]:text-ink-3">
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
                  <td className="text-ink-2">{note}</td>
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
