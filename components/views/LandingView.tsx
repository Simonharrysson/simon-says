import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { CONTACT_EMAIL, REPO_URL, TESTIMONIALS } from "@/components/landing/config";
import { HeroDemo } from "@/components/landing/HeroDemo";
import {
  AgendaMock,
  AssistantTiles,
  BriefMock,
  CallMock,
  ChatMock,
  MyTasksMock,
  PrivatMock,
  RoomMock,
  Stage,
  TaskMock,
  TreeMock,
} from "@/components/landing/mocks";
import { StartAction } from "@/components/landing/StartAction";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight, IconCheck, IconMail } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export interface LandingViewProps {
  /** Signed-in user, if any. */
  user: { email: string; id: string } | null;
  signIn: FormAction;
}

/** The FAQ's questions, in order (the FAQPage JSON-LD in app/page.tsx uses the same list). */
export const FAQ_KEYS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

const wrap = "mx-auto w-full max-w-page px-gutter";
const sectionY = "py-[clamp(4.5rem,10vw,8.5rem)]";
const h2Class = "max-w-[18ch] text-[clamp(2rem,1.25rem+3vw,3.5rem)] leading-[1.04] font-semibold tracking-[-0.035em] text-balance";
const leadClass = "max-w-[40rem] text-lg text-ink-2 min-[48rem]:text-xl min-[48rem]:leading-[1.5]";
const h3Class = "text-lg font-semibold tracking-[-0.015em]";
const mailto = (subject: string) => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;

/**
 * The public front page. One big idea per section, each with a picture of the real product:
 * the live demo, then before/during/after, room or Meet, Företag, Föreningar, Privat, your AI,
 * trust, price, questions and one last call to action. Every claim is something the app does
 * today; the pictures use fictional names (docs/ui.md, PRODUCT.md).
 */
export function LandingView({ user, signIn }: LandingViewProps) {
  const t = useTranslations("landing");
  const signedIn = Boolean(user);
  return (
    <>
      {/* ---------- Hero ---------- */}
      <section className="pt-[clamp(2.5rem,7vw,6rem)] pb-[clamp(3rem,6vw,5rem)]" aria-labelledby="hero-title">
        <div className={cn(wrap, "flex flex-col gap-[clamp(1.5rem,3vw,2.5rem)]")}>
          <h1
            id="hero-title"
            className="text-[clamp(2.625rem,1.3rem+5.2vw,6rem)] leading-[0.98] font-semibold tracking-[-0.04em] text-balance [overflow-wrap:break-word] hyphens-manual"
          >
            {/* One sentence per line, so the line count never depends on which font has loaded (no shift on swap). */}
            {t("heroTitle")
              .split(/(?<=\.)\s+/)
              .map((sentence) => (
                <span key={sentence} className="block">
                  {sentence}
                </span>
              ))}
          </h1>
          <div className="grid grid-cols-[minmax(0,1fr)] items-end gap-x-[clamp(2rem,5vw,5rem)] gap-y-6 min-[60rem]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <p className="max-w-[38rem] text-lg text-ink-2 min-[48rem]:text-xl min-[48rem]:leading-[1.5]">{t("heroText")}</p>
            <div className="flex flex-col gap-4 min-[60rem]:items-end">
              <div className="flex flex-wrap items-center gap-2 max-[30rem]:flex-col max-[30rem]:items-stretch max-[30rem]:[&_a]:w-full max-[30rem]:[&_button]:w-full">
                <StartAction signedIn={signedIn} signIn={signIn} google={!signedIn} />
                <a
                  className="press inline-flex min-h-12 items-center justify-center gap-2 rounded-md px-5 text-base font-medium text-ink-2 no-underline hover:bg-sunk hover:text-ink hover:no-underline"
                  href="#funktioner"
                >
                  {t("seeHow")}
                </a>
              </div>
              <p className="text-sm text-ink-3">{user ? t("signedInAs", { email: user.email }) : t("freeLine")}</p>
            </div>
          </div>
        </div>
        <div className={cn(wrap, "mt-[clamp(2.5rem,5vw,4.5rem)]")}>
          <HeroDemo />
        </div>
      </section>

      {/* ---------- Före, under och efter ---------- */}
      <Section id="funktioner" title={t("phases.title")} lead={t("phases.text")}>
        <PhaseStage />
        <ol className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-x-[clamp(1.5rem,3vw,2.5rem)] gap-y-12 min-[56rem]:mt-12 min-[56rem]:grid-cols-3">
          {(
            [
              ["before", <BriefMock key="b" />],
              ["during", <TaskMock key="d" />],
              ["after", <MyTasksMock key="a" />],
            ] as const
          ).map(([phase, mock]) => (
            <li key={phase} className="flex flex-col gap-2 border-t border-ink pt-4">
              <span className="font-mono text-sm text-ink-3 tabular-nums">{t(`phases.${phase}When`)}</span>
              <h3 className={h3Class}>{t(`phases.${phase}Title`)}</h3>
              <p className="text-ink-2">{t(`phases.${phase}Text`)}</p>
              {/* On a phone each phase carries its own picture. */}
              <Stage className="mt-4 min-[56rem]:hidden">{mock}</Stage>
            </li>
          ))}
        </ol>
      </Section>

      {/* ---------- I rummet eller i Google Meet ---------- */}
      <Section id="rum-eller-meet" title={t("where.title")} lead={t("where.text")} tinted>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-[clamp(1.5rem,3vw,2.5rem)] gap-y-12 min-[56rem]:grid-cols-2">
          <WhereCard title={t("where.roomTitle")} text={t("where.roomText")}>
            <RoomMock />
          </WhereCard>
          <WhereCard title={t("where.callTitle")} text={t("where.callText")}>
            <CallMock />
          </WhereCard>
        </div>
      </Section>

      {/* ---------- Företag ---------- */}
      <Split
        id="foretag"
        title={t("foretag.title")}
        lead={t("foretag.text")}
        picture={
          <Stage label={t("foretag.treeLabel")}>
            <TreeMock />
          </Stage>
        }
      >
        <Points
          items={[
            [t("foretag.point1Title"), t("foretag.point1Text")],
            [t("foretag.point2Title"), t("foretag.point2Text")],
            [t("foretag.point3Title"), t("foretag.point3Text")],
          ]}
        />
        <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-2">
          {t("foretag.pilot")}
          <a href={mailto(t("pricing.mailSubject"))} className="inline-flex min-h-11 items-center gap-1 font-medium">
            {t("foretag.contact")}
            <IconArrowRight size={16} />
          </a>
        </p>
      </Split>

      {/* ---------- Föreningar ---------- */}
      <Split
        id="foreningar"
        title={t("foreningar.title")}
        lead={t("foreningar.text")}
        reverse
        picture={
          <Stage>
            <AgendaMock />
          </Stage>
        }
      >
        <Points
          items={[
            [t("foreningar.point1Title"), t("foreningar.point1Text")],
            [t("foreningar.point2Title"), t("foreningar.point2Text")],
            [t("foreningar.point3Title"), t("foreningar.point3Text")],
          ]}
        />
      </Split>

      {/* ---------- Privat ---------- */}
      <Split
        id="privat"
        title={t("privat.title")}
        lead={t("privat.text")}
        picture={
          <Stage label={t("privat.mailLabel")}>
            <PrivatMock />
          </Stage>
        }
      >
        <ul className="flex flex-col gap-3 text-ink-2">
          {(["point1", "point2", "point3"] as const).map((key) => (
            <li key={key} className="flex items-center gap-3">
              <IconCheck size={18} className="flex-none text-green" />
              {t(`privat.${key}`)}
            </li>
          ))}
        </ul>
      </Split>

      {/* ---------- Din AI ---------- */}
      <Section id="ai" title={t("ai.title")} lead={t("ai.text")} tinted>
        <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-x-[clamp(2rem,5vw,4rem)] gap-y-10 min-[60rem]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <Stage label={t("ai.chatLabel")} className="bg-surface dark:bg-board">
            <ChatMock />
          </Stage>
          <div className="flex flex-col gap-4">
            <AssistantTiles />
            <p className="text-sm text-ink-3">{t("ai.how")}</p>
          </div>
        </div>
      </Section>

      {/* ---------- Trygghet ---------- */}
      <Section id="trygghet" title={t("trust.title")}>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-[clamp(2rem,6vw,6rem)] gap-y-14 min-[60rem]:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <FounderNote />
          <dl className="flex flex-col [&_dd]:text-ink-2 [&_dt]:font-semibold [&_dt]:tracking-[-0.01em]">
            <Fact title={t("trust.audioTitle")}>{t("trust.audioText")}</Fact>
            <Fact title={t("trust.docTitle")}>{t("trust.docText")}</Fact>
            <Fact title={t("trust.aiTitle")}>{t("trust.aiText")}</Fact>
            <Fact title={t("trust.gdprTitle")}>{t.rich("trust.gdprText", { link: (chunks) => <a href="/integritet">{chunks}</a> })}</Fact>
            <Fact title={t("trust.openTitle")}>
              {t.rich("trust.openText", {
                repo: (chunks) => (
                  <a href={REPO_URL} rel="noopener">
                    {chunks}
                  </a>
                ),
                status: (chunks) => <a href="/status">{chunks}</a>,
              })}
            </Fact>
          </dl>
        </div>
      </Section>

      {/* ---------- Från användare (hidden while TESTIMONIALS is empty; never invented) ---------- */}
      {TESTIMONIALS.length > 0 && (
        <Section id="omdomen" title={t("testimonials.title")}>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-6 min-[56rem]:grid-cols-3">
            {TESTIMONIALS.map((q) => (
              <li key={q.name} className="flex flex-col gap-4 border-t border-ink pt-5">
                <blockquote className="text-lg leading-snug">{q.quote}</blockquote>
                <p className="text-sm text-ink-3">
                  <span className="font-semibold text-ink">{q.name}</span>, {q.role}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ---------- Pris ---------- */}
      <Section id="pris" title={t("pricing.title")} lead={t("pricing.text")} tinted>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-[56rem]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div data-card className="flex flex-col gap-6 rounded-2xl bg-surface p-[clamp(1.5rem,3vw,2.5rem)] shadow-[0_1px_2px_rgb(0_0_0/0.05),0_16px_40px_-20px_rgb(0_0_0/0.25)]">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold text-ink-2">{t("pricing.betaName")}</h3>
              <p className="text-[clamp(2.5rem,2rem+2vw,3.5rem)] leading-none font-semibold tracking-[-0.04em]">{t("pricing.betaPrice")}</p>
              <p className="mt-2 text-ink-2">{t("pricing.betaFor")}</p>
            </div>
            <ul className="flex flex-col">
              {(["betaPoint1", "betaPoint2", "betaPoint3", "betaPoint4", "betaPoint5"] as const).map((key) => (
                <li key={key} className="flex items-start gap-3 border-t border-line py-3">
                  <IconCheck size={18} className="mt-0.5 flex-none text-green" />
                  {t(`pricing.${key}`)}
                </li>
              ))}
            </ul>
            <div className="mt-auto max-[30rem]:[&_a]:w-full max-[30rem]:[&_button]:w-full max-[30rem]:[&_form]:w-full">
              <StartAction signedIn={signedIn} signIn={signIn} />
            </div>
          </div>
          <div className="flex flex-col gap-6 rounded-2xl bg-board p-[clamp(1.5rem,3vw,2.5rem)]">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold text-ink-2">{t("pricing.foretagName")}</h3>
              <p className="text-[clamp(2rem,1.6rem+1.6vw,2.75rem)] leading-none font-semibold tracking-[-0.035em]">{t("pricing.foretagPrice")}</p>
              <p className="mt-2 text-ink-2">{t("pricing.foretagFor")}</p>
            </div>
            <p className="text-ink-2">{t("pricing.foretagText")}</p>
            <a
              href={mailto(t("pricing.mailSubject"))}
              className="press mt-auto inline-flex min-h-12 items-center justify-center gap-2 self-start rounded-md border border-control bg-surface px-6 text-base font-medium text-ink no-underline hover:bg-sunk hover:no-underline max-[30rem]:self-stretch"
            >
              <IconMail size={18} />
              {t("pricing.foretagCta")}
            </a>
          </div>
        </div>
      </Section>

      {/* ---------- FAQ ---------- */}
      <section id="faq" className={cn("scroll-mt-16", sectionY)} aria-labelledby="faq-title">
        <div className={cn(wrap, "grid grid-cols-[minmax(0,1fr)] gap-x-[clamp(2rem,6vw,6rem)] gap-y-8 min-[60rem]:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]")}>
          <h2 id="faq-title" className={cn(h2Class, "min-[60rem]:sticky min-[60rem]:top-28 min-[60rem]:self-start")}>
            {t("faq.title")}
          </h2>
          <Accordion type="single" collapsible className="border-t border-line">
            {FAQ_KEYS.map((n) => (
              <AccordionItem key={n} value={`q${n}`}>
                <AccordionTrigger>{t(`faq.q${n}`)}</AccordionTrigger>
                <AccordionContent>{t.rich(`faq.a${n}`, { link: (chunks) => <a href="/integritet">{chunks}</a> })}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* ---------- Sista uppmaningen ---------- */}
      <section className="pb-[clamp(3rem,8vw,6rem)]" aria-labelledby="close-title">
        <div className={wrap}>
          <div className="flex flex-col items-start gap-5 rounded-3xl bg-ink px-[clamp(1.5rem,6vw,5rem)] py-[clamp(3rem,8vw,6rem)] text-on-ink">
            <h2 id="close-title" className="max-w-[16ch] text-[clamp(2.25rem,1.4rem+3.6vw,4.25rem)] leading-[1.02] font-semibold tracking-[-0.04em] text-balance">
              {t("close.title")}
            </h2>
            <p className="max-w-[34rem] text-lg text-on-ink/80">{signedIn ? t("close.signedIn") : t("close.text")}</p>
            <div className="mt-3 max-[30rem]:w-full max-[30rem]:[&_a]:w-full max-[30rem]:[&_button]:w-full">
              <StartAction signedIn={signedIn} signIn={signIn} google={!signedIn} variant="secondary" />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/** A section: heading and lead over its content. `tinted` sets it on the sunk band. */
function Section({ id, title, lead, tinted = false, children }: { id: string; title: string; lead?: string; tinted?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={cn("scroll-mt-16", sectionY, tinted && "bg-sunk")} aria-labelledby={`${id}-title`}>
      <div className={wrap}>
        <div className="mb-[clamp(2.5rem,5vw,4rem)] flex flex-col gap-4">
          <h2 id={`${id}-title`} className={h2Class}>
            {title}
          </h2>
          {lead && <p className={leadClass}>{lead}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

/** Text on one side, the big picture on the other (`reverse` puts the picture first on wide screens). */
function Split({ id, title, lead, picture, reverse = false, children }: { id: string; title: string; lead: string; picture: ReactNode; reverse?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={cn("scroll-mt-16", sectionY)} aria-labelledby={`${id}-title`}>
      <div className={cn(wrap, "grid grid-cols-[minmax(0,1fr)] items-center gap-x-[clamp(2.5rem,6vw,6rem)] gap-y-12 min-[60rem]:grid-cols-2")}>
        <div className={cn("flex flex-col", reverse && "min-[60rem]:order-2")}>
          <h2 id={`${id}-title`} className={h2Class}>
            {title}
          </h2>
          <p className={cn(leadClass, "mt-4 mb-8")}>{lead}</p>
          {children}
        </div>
        <div className={cn(reverse && "min-[60rem]:order-1")}>{picture}</div>
      </div>
    </section>
  );
}

/** The room or the call: its picture on a white stage, then what to do. */
function WhereCard({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <Stage className="min-h-[19rem] bg-surface min-[56rem]:h-[21rem] dark:bg-board">{children}</Stage>
      <div className="flex flex-col gap-2">
        <h3 className={h3Class}>{title}</h3>
        <p className="max-w-[34rem] text-ink-2">{text}</p>
      </div>
    </div>
  );
}

/** Three short points, divided by hairlines. */
function Points({ items }: { items: [string, string][] }) {
  return (
    <ul className="flex flex-col">
      {items.map(([title, text]) => (
        <li key={title} className="flex flex-col gap-1 border-t border-line py-4">
          <h3 className="font-semibold tracking-[-0.01em]">{title}</h3>
          <p className="text-ink-2">{text}</p>
        </li>
      ))}
    </ul>
  );
}

function Fact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-t border-line py-5 first:border-t-0 first:pt-0">
      <dt>{title}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Before, during, after on one wide stage (wide screens; phones show each with its phase). */
function PhaseStage() {
  return (
    <Stage className="hidden grid-cols-3 items-start gap-[clamp(1rem,2.5vw,2rem)] min-[56rem]:grid">
      <BriefMock />
      <div className="w-full pt-10">
        <TaskMock />
      </div>
      <div className="w-full pt-20">
        <MyTasksMock />
      </div>
    </Stage>
  );
}

/**
 * OWNER: Simon, edit this note (landing.json trust.founder1 / founder2). Plain first person,
 * nothing beyond what is true. No photo yet: an initials mark stands in.
 */
function FounderNote() {
  const t = useTranslations("landing.trust");
  return (
    <figure className="flex flex-col gap-6">
      <p className="text-sm font-medium text-ink-3">{t("founderLabel")}</p>
      <blockquote className="flex flex-col gap-4 text-[clamp(1.25rem,1.05rem+0.8vw,1.625rem)] leading-[1.4] tracking-[-0.015em] text-ink">
        <p>{t("founder1")}</p>
        <p>{t("founder2")}</p>
      </blockquote>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span aria-hidden="true" className="grid size-12 flex-none place-items-center rounded-full bg-ink font-logo text-xl text-on-ink">
          SH
        </span>
        <span className="flex flex-col">
          <span className="font-semibold">{t("founderName")}</span>
          <span className="text-sm text-ink-3">{t("founderRole")}</span>
        </span>
        <a href={`mailto:${CONTACT_EMAIL}`} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium min-[30rem]:ml-auto">
          <IconMail size={16} />
          {t("founderMail")}
        </a>
      </figcaption>
    </figure>
  );
}
