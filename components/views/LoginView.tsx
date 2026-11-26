import { useLocale, useTranslations } from "next-intl";
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
  const t = useTranslations("login");
  const message = loginError(error, useLocale());
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] grid items-start justify-items-center pt-[clamp(1rem,6vh,4rem)]">
      <div className="w-full max-w-[30rem] rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl">{message ? t("titleRetry") : t("title")}</h1>
          <p className="text-ink-2">
            {joining ? t("introJoining") : t("intro")}
          </p>
        </div>

        {message && (
          <Banner tone="danger" title={message.title}>
            {message.text}
          </Banner>
        )}

        {error === "drive" && <DriveScopeHelp />}

        <GoogleSignIn action={signIn} next={next} label={message ? t("googleRetry") : t("google")} />

        <ul className="flex flex-col gap-3 border-t border-line pt-4 text-sm text-ink-2">
          <li className="grid grid-cols-[auto_1fr] gap-3">
            <IconCheck size={18} className="mt-[0.15rem] text-green" />
            <span>{t.rich("onlyOwnDocs", { strong: (chunks) => <strong>{chunks}</strong> })}</span>
          </li>
          <li className="grid grid-cols-[auto_1fr] gap-3">
            <IconCheck size={18} className="mt-[0.15rem] text-green" />
            <span>{t("onlyStarter")}</span>
          </li>
        </ul>
        <p className="text-sm text-ink-3">
          {t.rich("privacy", { link: (chunks) => <a href="/integritet">{chunks}</a> })}
        </p>
      </div>
    </div>
  );
}

/** A drawn copy of Google's consent row, so people know which box to tick. */
function DriveScopeHelp() {
  const t = useTranslations("login");
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm text-ink-3">{t("scopeCaption")}</figcaption>
      <div className="grid grid-cols-[auto_1fr] items-start gap-3 rounded-md border border-line bg-board px-4 py-3 font-system text-sm [&_em]:font-semibold [&_em]:not-italic" aria-hidden="true">
        <span className="mt-[0.1rem] grid size-5 animate-scope-tick place-items-center rounded-[3px] bg-blue text-on-ink">
          <IconCheck size={16} />
        </span>
        <span>{t.rich("scopeRow", { em: (chunks) => <em>{chunks}</em> })}</span>
      </div>
      <p className="sr-only">{t("scopeRowSr")}</p>
    </figure>
  );
}
