import { ButtonLink } from "@/components/ui/Button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight, IconGoogle, IconPause, IconStop } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";

const REPO = "https://github.com/Simonharrysson/simon-says";

export interface LandingViewProps {
  /** Signed-in user, if any. */
  user: { email: string; id: string } | null;
  signIn: FormAction;
}

export function LandingView({ user, signIn }: LandingViewProps) {
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="page hero__grid">
          <div className="hero__copy">
            <h1 id="hero-title" className="hero__title">
              Anteckningarna skriver sig själva.
            </h1>
            <p className="lead">
              Öppna Simon Says på en laptop vid mötesbordet och tryck Starta. Medan ni pratar fylls ert eget
              Google-dokument med beslut, vem som gör vad och vad ni pratar om just nu. Det ni skriver själva rör vi
              aldrig.
            </p>
            <div className="hero__actions">
              {user ? (
                <ButtonLink href="/orgs" variant="primary" size="lg" icon={<IconArrowRight />}>
                  Till dina föreningar
                </ButtonLink>
              ) : (
                <form action={signIn}>
                  <input type="hidden" name="next" value="/orgs" />
                  <SubmitButton variant="primary" size="lg" icon={<IconGoogle />} pendingLabel="Skickar dig till Google…">
                    Logga in med Google
                  </SubmitButton>
                </form>
              )}
              <a className="btn btn--ghost btn--lg" href="#sa-funkar-det">
                Så går ett möte till
              </a>
            </div>
            <p className="subtle">
              {user ? (
                <>
                  Inloggad som {user.email}. Användar-id <code>{user.id}</code>
                </>
              ) : (
                "Gratis för föreningar i Linköping. Svenska, engelska och allt däremellan."
              )}
            </p>
          </div>

          <BoardDemo />
        </div>
      </section>

      <section id="sa-funkar-det" className="band" aria-labelledby="steps-title">
        <div className="page">
          <h2 id="steps-title" className="band__title">
            Så går ett möte till
          </h2>
          <ol className="steps">
            <li className="step">
              <h3 className="step__title">Alla i rummet vet</h3>
              <p className="muted">
                Den som håller i mötet bekräftar att alla vet att mötet transkriberas och kan be om paus. Först då går
                det att trycka Starta.
              </p>
            </li>
            <li className="step">
              <h3 className="step__title">Starta och prata som vanligt</h3>
              <p className="muted">
                Laptopens egen mikrofon räcker. En kort namnrunda först, så står det Anna och Erik i stället för Talare
                1 och Talare 2.
              </p>
            </li>
            <li className="step">
              <h3 className="step__title">Dokumentet fylls på</h3>
              <p className="muted">
                Ungefär en gång i minuten uppdateras anteckningarna: beslut, att göra med namn och datum, och vad som pågår.
                Hela transkriptionen ligger i en egen flik.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="band band--sunk" aria-labelledby="edits-title">
        <div className="page split">
          <div className="stack stack--4">
            <h2 id="edits-title" className="band__title">
              Det ni skriver själva rör vi aldrig.
            </h2>
            <p className="muted measure">
              Sekreteraren kan skriva i dokumentet under hela mötet. Rättar du en punkt låses den: Simon Says skriver
              runt den, men ändrar eller tar aldrig bort din text. Inte ens i sammanfattningen när mötet är slut.
            </p>
          </div>
          <div className="edit-demo" aria-hidden="true">
            <p className="edit-demo__label">Att göra</p>
            <p className="edit-demo__line">
              <span className="doc-box" /> Erik: skicka budgeten till kassören (ons)
            </p>
            <p className="edit-demo__line edit-demo__line--human">
              <span className="doc-box" /> Anna: boka Kårallen <ins>— helst lilla salen</ins>
              <span className="edit-demo__caret" />
            </p>
            <p className="edit-demo__note">
              Ändrat av en människa · låst
            </p>
          </div>
        </div>
      </section>

      <section className="band" aria-labelledby="facts-title">
        <div className="page">
          <h2 id="facts-title" className="band__title">
            Gjort för ett rum fullt av folk
          </h2>
          <dl className="facts-grid">
            <div>
              <dt>En laptop, ingen utrustning</dt>
              <dd>Den inbyggda mikrofonen räcker. Inget att installera, ingen extra mikrofon att köpa.</dd>
            </div>
            <div>
              <dt>Svenska och engelska</dt>
              <dd>Även när någon byter språk mitt i en mening.</dd>
            </div>
            <div>
              <dt>Paus när någon ber om det</dt>
              <dd>En knapp. Inget ljud skickas förrän du trycker Fortsätt.</dd>
            </div>
            <div>
              <dt>Ert dokument, er Drive</dt>
              <dd>Dokumentet skapas i Google Drive hos den som startar mötet och delas med föreningens medlemmar.</dd>
            </div>
          </dl>
          <p className="facts-line muted">
            Gratis: upp till 20 timmar i månaden per förening och 4 timmar per möte. Öppen källkod på{" "}
            <a href={REPO}>GitHub</a>, och hur det går just nu syns på <a href="/status">statussidan</a>.
          </p>
        </div>
      </section>

      <section className="band band--close" aria-labelledby="close-title">
        <div className="page close">
          <h2 id="close-title" className="close__title">
            Har ni möte i veckan?
          </h2>
          <p className="muted">Skapa föreningen, bjud in styrelsen och lägg laptopen på bordet.</p>
          {user ? (
            <ButtonLink href="/orgs" variant="primary" size="lg" icon={<IconArrowRight />}>
              Till dina föreningar
            </ButtonLink>
          ) : (
            <form action={signIn}>
              <input type="hidden" name="next" value="/orgs" />
              <SubmitButton variant="primary" size="lg" icon={<IconGoogle />} pendingLabel="Skickar dig till Google…">
                Logga in med Google
              </SubmitButton>
            </form>
          )}
        </div>
      </section>
    </>
  );
}

/**
 * The hero's proof: a Doc pinned to the board, writing itself, and the laptop's control
 * strip under it. Synthetic example content, labelled as such. Lines reveal once, like a
 * marker stroke (clip-path), and are fully visible without motion.
 */
function BoardDemo() {
  return (
    <figure className="board" aria-label="Exempel: ett mötesdokument som fylls i under mötet">
      <div className="board__sheet">
        <div className="doc">
          <p className="doc__title">Styrelsemöte, 24 nov</p>
          <p className="doc__live">
            LIVE · uppdaterad 18:42
          </p>
          <p className="doc__attend w w1">Närvarande: Simon, Anna, Erik, Sara</p>

          <p className="doc__h w w2">Beslut</p>
          <p className="doc__line w w3">
            <span className="doc__check" aria-hidden="true">
              ✓
            </span>
            Hackathon 14 februari, budget 8 000 kr
          </p>

          <p className="doc__h w w4">Att göra</p>
          <p className="doc__line w w5">
            <span className="doc-box" aria-hidden="true" />
            Simon: boka lokal (fredag)
          </p>
          <p className="doc__line w w6">
            <span className="doc-box" aria-hidden="true" />
            Anna: mejla tre sponsorer (tisdag)
          </p>

          <p className="doc__h w w7">Pågår nu</p>
          <p className="doc__line doc__now w w8">Om vi ska ta inträde på hackathonet (Erik, Sara)</p>
        </div>
      </div>

      <div className="board__strip" aria-hidden="true">
        <span className="board__rec">
          LIVE 42:10
        </span>
        <span className="board__partial">…då täcker inträdet pizzan</span>
        <span className="board__ctrl">
          <IconPause size={16} />
        </span>
        <span className="board__ctrl">
          <IconStop size={14} />
        </span>
      </div>
      <figcaption className="board__caption">Exempel. Så här ser dokumentet ut medan ni pratar.</figcaption>
    </figure>
  );
}
