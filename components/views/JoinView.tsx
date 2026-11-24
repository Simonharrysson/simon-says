import { Banner } from "@/components/ui/Banner";
import { ButtonLink } from "@/components/ui/Button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight, IconUsers } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { GoogleSignIn } from "./GoogleButton";

export type JoinViewProps =
  | { state: "signed-out"; code: string; signIn: FormAction }
  | { state: "invalid" }
  | { state: "ready"; code: string; orgName: string; join: FormAction };

/** Invite landing. Joining is always a button press (POST), never a side effect of opening the link. */
export function JoinView(props: JoinViewProps) {
  return (
    <div className="page page--narrow auth">
      <div className="auth__sheet stack" style={{ ["--stack-gap" as string]: "1.5rem" }}>
        <span className="auth__icon" aria-hidden="true">
          <IconUsers size={28} />
        </span>
        {props.state === "signed-out" && (
          <>
            <div className="stack" style={{ ["--stack-gap" as string]: "0.5rem" }}>
              <h1 className="auth__title">Du är inbjuden</h1>
              <p className="muted">
                Logga in med Google för att se vilken förening som bjudit in dig och gå med. Det tar en halv minut.
              </p>
            </div>
            <GoogleSignIn action={props.signIn} next={`/join/${props.code}`} />
          </>
        )}

        {props.state === "invalid" && (
          <>
            <h1 className="auth__title">Länken fungerar inte längre</h1>
            <Banner tone="danger" title="Inbjudningslänken gäller inte">
              En admin har troligen skapat en ny länk. Be den som bjöd in dig att skicka den nya.
            </Banner>
            <ButtonLink href="/orgs" icon={<IconArrowRight />}>
              Till dina organisationer
            </ButtonLink>
          </>
        )}

        {props.state === "ready" && (
          <>
            <div className="stack" style={{ ["--stack-gap" as string]: "0.5rem" }}>
              <p className="muted">Du är inbjuden till</p>
              <h1 className="auth__title join__org">{props.orgName}</h1>
              <p className="muted">
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
