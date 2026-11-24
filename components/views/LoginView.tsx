import { Banner } from "@/components/ui/Banner";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconCheck } from "@/components/ui/icons";
import { loginError } from "@/lib/ui/messages";
import { GoogleSignIn } from "./GoogleButton";

export interface LoginViewProps {
  /** The `?fel=` code from the callback, if any. */
  error?: string;
  /** Safe same-site path to return to after login. */
  next: string;
  signIn: FormAction;
  /** Invite context: shown when the user came from /join. */
  joining?: boolean;
}

export function LoginView({ error, next, signIn, joining }: LoginViewProps) {
  const message = loginError(error);
  return (
    <div className="page page--narrow auth">
      <div className="auth__sheet stack stack--5">
        <div className="stack stack--2">
          <h1 className="auth__title">{message ? "Försök en gång till" : "Logga in"}</h1>
          <p className="muted">
            {joining
              ? "Logga in för att gå med i föreningen. Du kommer tillbaka till inbjudan direkt efteråt."
              : "Du loggar in med ditt Google-konto. Mötesanteckningarna sparas i din egen Google Drive."}
          </p>
        </div>

        {message && (
          <Banner tone="danger" title={message.title}>
            {message.text}
          </Banner>
        )}

        {error === "drive" && <DriveScopeHelp />}

        <GoogleSignIn action={signIn} next={next} label={message ? "Försök igen med Google" : "Logga in med Google"} />

        <ul className="auth__facts">
          <li>
            <IconCheck size={18} />
            <span>
              Vi får bara skapa och redigera <strong>de dokument Simon Says själv skapar</strong>. Resten av din Drive
              ser vi inte.
            </span>
          </li>
          <li>
            <IconCheck size={18} />
            <span>Bara den som startar mötet behöver ett konto. Övriga i rummet är bara namn i en lista.</span>
          </li>
        </ul>
        <p className="subtle">
          Läs hur vi hanterar ljud, text och konton i <a href="/integritet">integritetsinformationen</a>.
        </p>
      </div>
    </div>
  );
}

/** A drawn copy of Google's consent row, so people know which box to tick. */
function DriveScopeHelp() {
  return (
    <figure className="scope-help">
      <figcaption className="subtle">När Google frågar, kryssa i den här rutan:</figcaption>
      <div className="scope-help__row" aria-hidden="true">
        <span className="scope-help__box">
          <IconCheck size={16} />
        </span>
        <span>
          Visa, redigera, skapa och radera <em>endast de specifika Google Drive-filer som du använder med den här appen</em>
        </span>
      </div>
      <p className="visually-hidden">
        Rutan heter: Visa, redigera, skapa och radera endast de specifika Google Drive-filer som du använder med den här
        appen.
      </p>
    </figure>
  );
}
