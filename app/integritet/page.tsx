import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { PublicShell } from "@/components/views/PublicShell";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("privacy"))("metaTitle") };
}

// Plain-language privacy text for a free service (lib/i18n/messages/*/privacy.json). Update
// `updated` there when the content changes.

const processors = ["elevenlabs", "anthropic", "google", "supabase", "vercel", "resend"] as const;
const processorNames: Record<(typeof processors)[number], string> = {
  elevenlabs: "ElevenLabs",
  anthropic: "Anthropic",
  google: "Google",
  supabase: "Supabase",
  vercel: "Vercel",
  resend: "Resend",
};

const toc = [
  ["kort", "kort"],
  ["i-rummet", "rummet"],
  ["sparas", "sparas"],
  ["mejl", "mejl"],
  ["vem", "vem"],
  ["grund", "grund"],
  ["rattigheter", "rattigheter"],
  ["radera", "radera"],
  ["kontakt", "kontakt"],
] as const;

const MAIL = "mailto:simon@harrysson.co";
const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;
const mail = (chunks: ReactNode) => <a href={MAIL}>{chunks}</a>;

export default async function PrivacyPage() {
  const t = await getTranslations("privacy");
  return (
    <PublicShell signedIn={false}>
      <article className="mx-auto w-full px-gutter max-w-[46rem] flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-dashed border-red px-[0.65rem] py-1 text-xs font-semibold text-red">{t("draft", { date: t("updated") })}</span>
          <h1 className="text-2xl wrap-anywhere">{t("title")}</h1>
          <p className="max-w-[38rem] text-lg text-ink-2">{t("lead")}</p>
          <nav className="flex flex-wrap gap-2 text-sm [&_a]:rounded-md [&_a]:bg-sunk [&_a]:px-[0.7rem] [&_a]:py-[0.3rem] [&_a]:text-ink-2 [&_a]:no-underline [&_a:hover]:text-ink" aria-label={t("tocLabel")}>
            {toc.map(([anchor, key]) => (
              <a key={anchor} href={`#${anchor}`}>
                {t(`toc.${key}`)}
              </a>
            ))}
          </nav>
        </div>

        <div className="flex max-w-[68ch] flex-col gap-4 [&_h2]:mt-8 [&_h2]:text-xl [&_h3]:mt-3 [&_h3]:text-lg [&_li]:marker:text-ink-3 [&_ul]:flex [&_ul]:list-dash [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5">
          <h2 id="kort">{t("toc.kort")}</h2>
          <ul>
            <li>{t("short.audio")}</li>
            <li>{t("short.doc")}</li>
            <li>{t("short.kept")}</li>
            <li>{t("short.accounts")}</li>
            <li>{t.rich("short.controller", { strong })}</li>
          </ul>

          <h2 id="i-rummet">{t("toc.rummet")}</h2>
          <p>{t("room.consent")}</p>
          <p>{t("room.transcript")}</p>

          <h2 id="sparas">{t("toc.sparas")}</h2>
          <h3>{t("stored.signedInTitle")}</h3>
          <ul>
            <li>{t("stored.nameEmail")}</li>
            <li>{t("stored.key")}</li>
          </ul>
          <h3>{t("stored.orgTitle")}</h3>
          <ul>
            <li>{t("stored.orgBasics")}</li>
            <li>{t("stored.invites")}</li>
            <li>{t("stored.meetings")}</li>
            <li>{t("stored.usage")}</li>
            <li>{t("stored.createdLog")}</li>
            <li>{t("stored.summary")}</li>
            <li>{t("stored.privat")}</li>
            <li>{t("stored.overview")}</li>
            <li>{t("stored.history")}</li>
            <li>{t("stored.drive")}</li>
          </ul>
          <p>{t.rich("stored.kept", { strong })}</p>
          <h3>{t("stored.notTitle")}</h3>
          <ul>
            <li>{t("stored.notAudio")}</li>
            <li>{t("stored.notDrive")}</li>
            <li>{t("stored.notVoice")}</li>
          </ul>

          <h2 id="mejl">{t("toc.mejl")}</h2>
          <p>{t("mail")}</p>

          <h2 id="vem">{t("toc.vem")}</h2>
          <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-line [&_td]:py-3 [&_td]:pr-3 [&_td]:text-left [&_td]:align-top [&_th]:border-b [&_th]:border-line [&_th]:py-3 [&_th]:pr-3 [&_th]:text-left [&_th]:align-top [&_th]:text-xs [&_th]:font-semibold [&_th]:text-ink-3">
            <thead>
              <tr>
                <th scope="col">{t("processors.service")}</th>
                <th scope="col">{t("processors.does")}</th>
                <th scope="col">{t("processors.goodToKnow")}</th>
              </tr>
            </thead>
            <tbody>
              {processors.map((key) => (
                <tr key={key}>
                  <th scope="row">{processorNames[key]}</th>
                  <td>{t(`processors.${key}.what`)}</td>
                  <td className="text-ink-2">{t(`processors.${key}.note`)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 id="grund">{t("toc.grund")}</h2>
          <p>{t("legal.intro")}</p>
          <ul>
            <li>{t.rich("legal.account", { strong })}</li>
            <li>{t.rich("legal.room", { strong })}</li>
          </ul>

          <h2 id="rattigheter">{t("toc.rattigheter")}</h2>
          <p>{t.rich("rights", { mail, imy: (chunks) => <a href="https://www.imy.se">{chunks}</a> })}</p>

          <h2 id="overforing">{t("transferTitle")}</h2>
          <p>{t("transfer")}</p>

          <h2 id="radera">{t("toc.radera")}</h2>
          <ul>
            <li>{t.rich("delete.meeting", { strong })}</li>
            <li>{t.rich("delete.privat", { strong })}</li>
            <li>{t.rich("delete.org", { strong })}</li>
            <li>{t.rich("delete.account", { strong, mail })}</li>
            <li>
              {t.rich("delete.google", {
                strong,
                link: (chunks) => <a href="https://myaccount.google.com/connections">{chunks}</a>,
              })}
            </li>
            <li>{t.rich("delete.docs", { strong })}</li>
          </ul>

          <h2 id="statussidan">{t("statusTitle")}</h2>
          <p>{t("status")}</p>

          <h2 id="kontakt">{t("toc.kontakt")}</h2>
          <p>{t.rich("contact", { mail })}</p>
        </div>
      </article>
    </PublicShell>
  );
}
