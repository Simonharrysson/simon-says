import { Banner } from "@/components/ui/Banner";
import type { EmailCategory, EmailPrefs } from "@/lib/email/categories";
import { EMAIL_CATEGORY_INFO } from "@/lib/email/categories";
import { EmailPrefsForm, type SaveEmailPrefs } from "./EmailPrefsForm";

export type MailPrefsViewProps =
  | { state: "ready"; email: string; prefs: EmailPrefs; save: SaveEmailPrefs; highlight?: EmailCategory }
  | { state: "invalid" }
  | { state: "error" };

/**
 * /mejl: the link at the bottom of every mail. No login: the signed link names the address, and
 * only that address's choices can be changed here. Opening the page changes nothing.
 */
export function MailPrefsView(props: MailPrefsViewProps) {
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] grid items-start justify-items-center pt-[clamp(1rem,6vh,4rem)]">
      <div className="w-full max-w-[34rem] rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel flex flex-col gap-6">
        {props.state === "ready" && (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl">Mejl från Simon Says</h1>
              <p className="text-ink-2">
                Välj vilka mejl som ska gå till <strong className="font-medium text-ink wrap-anywhere">{props.email}</strong>.
                {props.highlight
                  ? ` Vill du slippa ${EMAIL_CATEGORY_INFO[props.highlight].label.toLowerCase()}, stäng av den översta.`
                  : ""}{" "}
                Ändringen gäller direkt.
              </p>
            </div>
            <EmailPrefsForm initial={props.prefs} save={props.save} idPrefix="link-mail" highlight={props.highlight} />
            <p className="text-sm text-ink-3">
              Har du ett konto hittar du samma val under Konto. Läs mer i{" "}
              <a href="/integritet#mejl">integritetsinformationen</a>.
            </p>
          </>
        )}
        {props.state === "invalid" && (
          <>
            <h1 className="text-2xl">Länken fungerar inte</h1>
            <Banner tone="danger" title="Vi känner inte igen länken">
              Den kan ha klippts av i mejlet. Öppna länken längst ner i mejlet igen, eller logga in och välj under Konto.
            </Banner>
          </>
        )}
        {props.state === "error" && (
          <>
            <h1 className="text-2xl">Mejl från Simon Says</h1>
            <Banner tone="warning" title="Dina val gick inte att hämta just nu">
              Ladda om sidan om en stund. Valen du gjort tidigare gäller fortfarande.
            </Banner>
          </>
        )}
      </div>
    </div>
  );
}
