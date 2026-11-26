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
    <div className="mx-auto w-full px-gutter max-w-[40rem] grid items-start justify-items-center pt-[clamp(1rem,6vh,4rem)]">
      <div className="w-full max-w-[30rem] rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl">{message ? "Försök en gång till" : "Logga in"}</h1>
          <p className="text-ink-2">
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

        <ul className="flex flex-col gap-3 border-t border-line pt-4 text-sm text-ink-2">
          <li className="grid grid-cols-[auto_1fr] gap-3">
            <IconCheck size={18} className="mt-[0.15rem] text-green" />
            <span>
              Vi får bara skapa och redigera <strong>de dokument Simon Says själv skapar</strong>. Resten av din Drive
              ser vi inte.
            </span>
          </li>
          <li className="grid grid-cols-[auto_1fr] gap-3">
            <IconCheck size={18} className="mt-[0.15rem] text-green" />
            <span>Bara den som startar mötet behöver ett konto. Övriga i rummet är bara namn i en lista.</span>
          </li>
        </ul>
        <p className="text-sm text-ink-3">
          Läs hur vi hanterar ljud, text och konton i <a href="/integritet">integritetsinformationen</a>.
        </p>
      </div>
    </div>
  );
}

/** A drawn copy of Google's consent row, so people know which box to tick. */
function DriveScopeHelp() {
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm text-ink-3">När Google frågar, kryssa i den här rutan:</figcaption>
      <div className="grid grid-cols-[auto_1fr] items-start gap-3 rounded-md border border-line bg-board px-4 py-3 font-system text-sm [&_em]:font-semibold [&_em]:not-italic" aria-hidden="true">
        <span className="mt-[0.1rem] grid size-5 animate-scope-tick place-items-center rounded-[3px] bg-blue text-on-ink">
          <IconCheck size={16} />
        </span>
        <span>
          Visa, redigera, skapa och radera <em>endast de specifika Google Drive-filer som du använder med den här appen</em>
        </span>
      </div>
      <p className="sr-only">
        Rutan heter: Visa, redigera, skapa och radera endast de specifika Google Drive-filer som du använder med den här
        appen.
      </p>
    </figure>
  );
}
