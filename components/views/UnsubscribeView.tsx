import { Banner } from "@/components/ui/Banner";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { SubmitButton } from "@/components/ui/SubmitButton";

export type UnsubscribeViewProps =
  | { state: "confirm"; token: string; orgName: string; unsubscribe: FormAction }
  | { state: "done"; orgName: string }
  | { state: "invalid" };

/**
 * "Avsluta prenumeration" from a summary e-mail (0037). Opening the link changes nothing (mail
 * scanners open links); the button does. Mail clients' one-click goes to the API route instead.
 */
export function UnsubscribeView(props: UnsubscribeViewProps) {
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] grid items-start justify-items-center pt-[clamp(1rem,6vh,4rem)]">
      <div className="w-full max-w-[30rem] rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel flex flex-col gap-6">
        {props.state === "confirm" && (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl wrap-anywhere">Sluta få sammanfattningar från {props.orgName}?</h1>
              <p className="text-ink-2">
                Du får inga fler mejl med beslut och uppgifter efter föreningens möten. Mötesdokumenten finns kvar som
                vanligt.
              </p>
            </div>
            <form action={props.unsubscribe}>
              <input type="hidden" name="t" value={props.token} />
              <SubmitButton variant="primary" size="lg" block pendingLabel="Avslutar…">
                Avsluta prenumeration
              </SubmitButton>
            </form>
          </>
        )}
        {props.state === "done" && (
          <>
            <h1 className="text-2xl">Klart</h1>
            <Banner tone="success" title="Prenumerationen är avslutad" live={false}>
              Du får inga fler sammanfattningar från {props.orgName}. Ångrar du dig, mejla{" "}
              <a href="mailto:simon@harrysson.co">simon@harrysson.co</a>.
            </Banner>
          </>
        )}
        {props.state === "invalid" && (
          <>
            <h1 className="text-2xl">Länken fungerar inte</h1>
            <Banner tone="danger" title="Vi känner inte igen länken" live={false}>
              Den kan vara ofullständig, eller så har du tagits bort ur föreningens personlista. Då får du inga fler
              sammanfattningar.
            </Banner>
          </>
        )}
      </div>
    </div>
  );
}
