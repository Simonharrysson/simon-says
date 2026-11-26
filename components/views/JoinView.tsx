import { Banner } from "@/components/ui/Banner";
import { ButtonLink } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { GoogleSignIn } from "./GoogleButton";

export type JoinViewProps =
  | { state: "signed-out"; code: string; signIn: FormAction }
  | { state: "invalid" }
  | { state: "ready"; code: string; orgName: string; join: FormAction };

/** Invite landing. Joining is always a button press (POST), never a side effect of opening the link. */
export function JoinView(props: JoinViewProps) {
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] grid items-start justify-items-center pt-[clamp(1rem,6vh,4rem)]">
      <div className="w-full max-w-[30rem] rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel flex flex-col gap-6">
        {props.state === "signed-out" && (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl">Du är inbjuden</h1>
              <p className="text-ink-2">
                Logga in med Google för att se vilken förening som bjudit in dig och gå med. Det tar en halv minut.
              </p>
            </div>
            <GoogleSignIn action={props.signIn} next={`/join/${props.code}`} />
          </>
        )}

        {props.state === "invalid" && (
          <>
            <h1 className="text-2xl">Länken fungerar inte längre</h1>
            <Banner tone="danger" title="Inbjudningslänken gäller inte">
              En admin har troligen skapat en ny länk. Be den som bjöd in dig att skicka den nya.
            </Banner>
            <ButtonLink href="/orgs" icon={<IconArrowRight />}>
              Till dina föreningar
            </ButtonLink>
          </>
        )}

        {props.state === "ready" && (
          <>
            <div className="flex flex-col gap-2">
              <p className="text-ink-2">Du är inbjuden till</p>
              <h1 className="text-[clamp(2rem,1.5rem+2vw,2.75rem)] wrap-anywhere">{props.orgName}</h1>
              <p className="text-ink-2">
                Som medlem kan du starta möten och får tillgång till mötesdokument som skapas från och med nu.
              </p>
            </div>
            <form action={props.join}>
              <input type="hidden" name="code" value={props.code} />
              <SubmitButton variant="primary" size="lg" block pendingLabel="Går med…">
                Gå med i {props.orgName}
              </SubmitButton>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
