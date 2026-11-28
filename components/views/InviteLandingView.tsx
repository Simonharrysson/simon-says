import { useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink, buttonVariants } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight } from "@/components/ui/icons";
import { GoogleSignIn } from "./GoogleButton";

// The landing after the invite mail's button (/in/<token>, 0063). It shows only the förening, the
// meeting's title and the invited address masked: never tasks or decisions, so a forwarded mail's
// link shows the next person nothing they could not read in the mail itself. Every state labelled.

export type InviteLandingState =
  | { state: "signed-out" }
  | { state: "ready"; email: string }
  | { state: "mismatch"; current: string }
  | { state: "used" }
  | { state: "expired"; signedIn: boolean }
  | { state: "gone" }
  | { state: "error" };

export interface InviteLandingProps {
  token: string;
  orgName: string;
  title: string;
  starterName: string | null;
  maskedEmail: string;
  view: InviteLandingState;
  signIn: FormAction;
  switchAccount: FormAction;
}

export function InviteLandingView(p: InviteLandingProps) {
  const t = useTranslations("join.meetingInvite");
  const starter = p.starterName ?? t("starterFallback");
  const strong = (chunks: React.ReactNode) => <strong className="wrap-anywhere">{chunks}</strong>;
  const claim = `/in/${p.token}/klar`;
  const switchForm = (
    <form action={p.switchAccount}>
      <input type="hidden" name="next" value={`/in/${p.token}`} />
      <Button type="submit" variant="ghost" size="sm">
        {t("switchAccount")}
      </Button>
    </form>
  );
  return (
    <div className="mx-auto grid w-full max-w-[40rem] items-start justify-items-center px-gutter pt-[clamp(1rem,6vh,4rem)]">
      <div data-card className="flex w-full max-w-[30rem] flex-col gap-6 rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-2 wrap-anywhere">{t("eyebrow", { org: p.orgName })}</p>
          <h1 className="text-[clamp(1.75rem,1.4rem+1.6vw,2.5rem)] wrap-anywhere">{p.title}</h1>
          {(p.view.state === "signed-out" || p.view.state === "ready") && (
            <p className="text-ink-2">{p.starterName ? t("lead", { starter: p.starterName }) : t("leadNoStarter")}</p>
          )}
        </div>

        {p.view.state === "signed-out" && (
          <>
            <p className="text-sm text-ink-2">{t.rich("sentTo", { email: p.maskedEmail, strong })}</p>
            <div className="flex flex-col gap-3">
              <GoogleSignIn action={p.signIn} next={claim} label={t("continue")} />
              <p className="text-center text-xs text-ink-3">{t("signInNote")}</p>
            </div>
          </>
        )}

        {p.view.state === "ready" && (
          <>
            <ClaimLink href={claim} primary>
              {t("open")}
            </ClaimLink>
            <div className="flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
              <span>{t.rich("signedInAs", { email: p.view.email, strong })}</span>
              {switchForm}
            </div>
          </>
        )}

        {p.view.state === "mismatch" && (
          <>
            <Banner tone="danger" title={t("mismatchTitle")}>
              {t("mismatchText", { email: p.maskedEmail, current: p.view.current, starter })}
            </Banner>
            <form action={p.switchAccount}>
              <input type="hidden" name="next" value={`/in/${p.token}`} />
              <Button type="submit" variant="primary" size="lg" block>
                {t("switchAccount")}
              </Button>
            </form>
          </>
        )}

        {p.view.state === "used" && (
          <Banner tone="danger" title={t("usedTitle")}>
            {t("usedText", { starter })}
          </Banner>
        )}

        {p.view.state === "expired" && (
          <>
            <Banner tone="warning" title={t("expiredTitle")}>
              {t("expiredText")}
            </Banner>
            {!p.view.signedIn && <GoogleSignIn action={p.signIn} next="/hem" label={t("signIn")} />}
          </>
        )}

        {p.view.state === "gone" && (
          <Banner tone="danger" title={t("goneTitle")}>
            {t("goneText")}
          </Banner>
        )}

        {p.view.state === "error" && (
          <>
            <Banner tone="danger" title={t("errorTitle")}>
              {t("errorText")}
            </Banner>
            <ClaimLink href={claim}>{t("retry")}</ClaimLink>
          </>
        )}
      </div>
    </div>
  );
}

/** A link that doesn't name any invite of ours. */
export function InviteInvalidView() {
  const t = useTranslations("join.meetingInvite");
  return (
    <div className="mx-auto grid w-full max-w-[40rem] items-start justify-items-center px-gutter pt-[clamp(1rem,6vh,4rem)]">
      <div data-card className="flex w-full max-w-[30rem] flex-col gap-6 rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel">
        <h1 className="text-2xl">{t("invalidTitle")}</h1>
        <p className="text-ink-2">{t("invalidText")}</p>
        <ButtonLink href="/" icon={<IconArrowRight />}>
          {t("toStart")}
        </ButtonLink>
      </div>
    </div>
  );
}

/**
 * The claim is a GET route (after the OAuth return): a plain <a>, never a prefetching Link, so
 * nothing calls it before a tap.
 */
function ClaimLink({ href, primary, children }: { href: string; primary?: boolean; children: React.ReactNode }) {
  return (
    <a data-slot="button" href={href} className={buttonVariants({ variant: primary ? "primary" : undefined, size: "lg", block: true })}>
      {children}
      {primary && <IconArrowRight aria-hidden="true" />}
    </a>
  );
}
