import { ButtonLink, buttonVariants } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight, IconGoogle, IconPause, IconStop } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { cn } from "@/lib/utils";
import {
  docAttendClass,
  docBoxClass,
  docCheckClass,
  docHeadingClass,
  docLineClass,
  docLiveClass,
  docNowClass,
  docPaperClass,
  docTitleClass,
} from "./doc-paper";

const REPO = "https://github.com/Simonharrysson/simon-says";

export interface LandingViewProps {
  /** Signed-in user, if any. */
  user: { email: string; id: string } | null;
  signIn: FormAction;
}

export function LandingView({ user, signIn }: LandingViewProps) {
  return (
    <>
      <section className="pt-[clamp(2rem,6vw,5rem)] pb-[clamp(2rem,4vw,3rem)]" aria-labelledby="hero-title">
        <div className="mx-auto grid w-full max-w-page grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] items-center gap-[clamp(2rem,5vw,4.5rem)] px-gutter max-[60rem]:grid-cols-[minmax(0,1fr)]">
          <div className="flex flex-col gap-6">
            <h1 id="hero-title" className="text-display leading-[1.05] font-semibold tracking-[-0.045em] [overflow-wrap:break-word] hyphens-manual">
              Anteckningarna skriver sig själva.
            </h1>
            <p className="max-w-[38rem] text-lg text-ink-2">
              Öppna Simon Says på en laptop vid mötesbordet och tryck Starta. Medan ni pratar fylls ert eget
              Google-dokument med beslut, vem som gör vad och vad ni pratar om just nu. Det ni skriver själva rör vi
              aldrig.
            </p>
            <div className="flex flex-wrap gap-2 max-[30rem]:[&_a]:w-full max-[30rem]:[&_button]:w-full max-[30rem]:[&>*]:w-full">
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
              <a className={buttonVariants({ variant: "ghost", size: "lg" })} href="#sa-funkar-det">
                Så går ett möte till
              </a>
            </div>
            <p className="text-sm text-ink-3">
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

      <section id="sa-funkar-det" className="py-[clamp(3rem,7vw,6rem)]" aria-labelledby="steps-title">
        <div className="mx-auto w-full max-w-page px-gutter">
          <h2 id="steps-title" className="max-w-[22ch] text-[clamp(1.75rem,1.3rem+1.6vw,2.5rem)] tracking-[-0.035em]">
            Så går ett möte till
          </h2>
          <ol className="mt-12 grid grid-cols-3 gap-8 max-md:grid-cols-1 max-md:gap-6">
            <li className="flex flex-col gap-2 border-t border-rail pt-3 [counter-increment:step]">
              <h3 className="text-lg before:text-ink-3 before:content-[counter(step)_'._']">Alla i rummet vet</h3>
              <p className="text-ink-2">
                Den som håller i mötet bekräftar att alla vet att mötet transkriberas och kan be om paus. Först då går
                det att trycka Starta.
              </p>
            </li>
            <li className="flex flex-col gap-2 border-t border-rail pt-3 [counter-increment:step]">
              <h3 className="text-lg before:text-ink-3 before:content-[counter(step)_'._']">Starta och prata som vanligt</h3>
              <p className="text-ink-2">
                Laptopens egen mikrofon räcker. En kort namnrunda först, så står det Anna och Erik i stället för Talare
                1 och Talare 2.
              </p>
            </li>
            <li className="flex flex-col gap-2 border-t border-rail pt-3 [counter-increment:step]">
              <h3 className="text-lg before:text-ink-3 before:content-[counter(step)_'._']">Dokumentet fylls på</h3>
              <p className="text-ink-2">
                Ungefär en gång i minuten uppdateras anteckningarna: beslut, att göra med namn och datum, och vad som pågår.
                Hela transkriptionen ligger i en egen flik.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="bg-sunk py-[clamp(3rem,7vw,6rem)]" aria-labelledby="edits-title">
        <div className="mx-auto grid w-full max-w-page grid-cols-2 items-center gap-[clamp(2rem,5vw,4rem)] px-gutter max-[52rem]:grid-cols-1">
          <div className="flex flex-col gap-4">
            <h2 id="edits-title" className="max-w-[22ch] text-[clamp(1.75rem,1.3rem+1.6vw,2.5rem)] tracking-[-0.035em]">
              Det ni skriver själva rör vi aldrig.
            </h2>
            <p className="text-ink-2 max-w-[68ch]">
              Sekreteraren kan skriva i dokumentet under hela mötet. Rättar du en punkt låses den: Simon Says skriver
              runt den, men ändrar eller tar aldrig bort din text. Inte ens i sammanfattningen när mötet är slut.
            </p>
          </div>
          <div className="flex flex-col gap-2 rounded-[4px] bg-white p-6 font-system text-sm text-[#202124] shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_4px_12px_-6px_rgb(0_0_0/0.12)]" aria-hidden="true">
            <p className="border-b border-[#e0e0e0] pb-1 text-2xs font-bold tracking-[0.06em] text-[#5f6368] uppercase">Att göra</p>
            <p className="flex flex-wrap items-baseline gap-[0.55em]">
              <span className={docBoxClass} /> Erik: skicka budgeten till kassören (ons)
            </p>
            <p className="-mx-2 flex flex-wrap items-baseline gap-[0.55em] rounded-[3px] bg-[#e8f0fe] px-2 py-[0.2rem] [&_ins]:text-[#1a56c4] [&_ins]:no-underline">
              <span className={docBoxClass} /> Anna: boka Kårallen <ins>— helst lilla salen</ins>
              <span className="inline-block h-[1.1em] w-[2px] translate-y-[0.18em] animate-caret bg-[#1a56c4]" />
            </p>
            <p className="inline-flex items-center gap-2 text-2xs font-semibold text-[#1a56c4]">
              Ändrat av en människa · låst
            </p>
          </div>
        </div>
      </section>

      <section className="py-[clamp(3rem,7vw,6rem)]" aria-labelledby="facts-title">
        <div className="mx-auto w-full max-w-page px-gutter">
          <h2 id="facts-title" className="max-w-[22ch] text-[clamp(1.75rem,1.3rem+1.6vw,2.5rem)] tracking-[-0.035em]">
            Gjort för ett rum fullt av folk
          </h2>
          <dl className="mt-12 grid grid-cols-4 gap-8 max-[56rem]:grid-cols-2 max-[34rem]:grid-cols-1 max-[34rem]:gap-6 [&>div]:border-t [&>div]:border-rail [&>div]:pt-3 [&_dd]:mt-2 [&_dd]:text-ink-2 [&_dt]:text-lg [&_dt]:font-semibold [&_dt]:tracking-[-0.01em]">
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
          <p className="mt-8 max-w-[48rem] text-ink-2">
            Gratis: upp till 20 timmar i månaden per förening och 4 timmar per möte. Öppen källkod på{" "}
            <a href={REPO}>GitHub</a>, och hur det går just nu syns på <a href="/status">statussidan</a>.
          </p>
        </div>
      </section>

      <section className="border-t border-line py-[clamp(3rem,7vw,6rem)]" aria-labelledby="close-title">
        <div className="mx-auto flex w-full max-w-page flex-col items-start gap-4 px-gutter">
          <h2 id="close-title" className="text-[clamp(2rem,1.4rem+2.4vw,3.25rem)] tracking-[-0.04em]">
            Har ni möte i veckan?
          </h2>
          <p className="text-ink-2">Skapa föreningen, bjud in styrelsen och lägg laptopen på bordet.</p>
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
    <figure className="relative flex flex-col gap-4 rounded-lg bg-sunk px-[clamp(1rem,3vw,2.25rem)] pt-[clamp(1.25rem,3vw,2.25rem)] pb-4 shadow-panel" aria-label="Exempel: ett mötesdokument som fylls i under mötet">
      <div className="relative">
        <div className={docPaperClass}>
          <p className={docTitleClass}>Styrelsemöte, 24 nov</p>
          <p className={docLiveClass}>
            LIVE · uppdaterad 18:42
          </p>
          <p className={cn(docAttendClass, "animate-write [animation-delay:0.3s] motion-reduce:animate-none")}>Närvarande: Simon, Anna, Erik, Sara</p>

          <p className={cn(docHeadingClass, "animate-write [animation-delay:1.0s] motion-reduce:animate-none")}>Beslut</p>
          <p className={cn(docLineClass, "animate-write [animation-delay:1.4s] motion-reduce:animate-none")}>
            <span className={docCheckClass} aria-hidden="true">
              ✓
            </span>
            Hackathon 14 februari, budget 8 000 kr
          </p>

          <p className={cn(docHeadingClass, "animate-write [animation-delay:2.4s] motion-reduce:animate-none")}>Att göra</p>
          <p className={cn(docLineClass, "animate-write [animation-delay:2.8s] motion-reduce:animate-none")}>
            <span className={docBoxClass} aria-hidden="true" />
            Simon: boka lokal (fredag)
          </p>
          <p className={cn(docLineClass, "animate-write [animation-delay:3.6s] motion-reduce:animate-none")}>
            <span className={docBoxClass} aria-hidden="true" />
            Anna: mejla tre sponsorer (tisdag)
          </p>

          <p className={cn(docHeadingClass, "animate-write [animation-delay:4.6s] motion-reduce:animate-none")}>Pågår nu</p>
          <p className={cn(docLineClass, docNowClass, "animate-write [animation-delay:5.0s] motion-reduce:animate-none")}>Om vi ska ta inträde på hackathonet (Erik, Sara)</p>
        </div>
      </div>

      <div className="mx-[clamp(0rem,4vw,2.5rem)] flex items-center gap-3 rounded-md bg-surface py-2 pr-2 pl-3 text-xs shadow-panel" aria-hidden="true">
        <span className="inline-flex items-center gap-2 font-mono font-medium text-red tabular-nums">
          LIVE 42:10
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-3">…då täcker inträdet pizzan</span>
        <span className="grid size-8 place-items-center rounded-md border border-rail text-ink-2">
          <IconPause size={16} />
        </span>
        <span className="grid size-8 place-items-center rounded-md border border-rail text-ink-2">
          <IconStop size={14} />
        </span>
      </div>
      <figcaption className="text-center text-xs text-ink-3">Exempel. Så här ser dokumentet ut medan ni pratar.</figcaption>
    </figure>
  );
}
