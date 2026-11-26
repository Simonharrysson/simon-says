import { useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { GoogleSignIn } from "./GoogleButton";

export type JoinViewProps =
  | { state: "signed-out"; code: string; signIn: FormAction }
  | { state: "invalid" }
  | { state: "ready"; code: string; orgName: string; join: FormAction; email?: string; switchAccount?: FormAction };

/** Invite landing. Joining is always a button press (POST), never a side effect of opening the link. */
export function JoinView(props: JoinViewProps) {
  const t = useTranslations("join");
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] grid items-start justify-items-center pt-[clamp(1rem,6vh,4rem)]">
      <div className="w-full max-w-[30rem] rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel flex flex-col gap-6">
        {props.state === "signed-out" && (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl">{t("invitedTitle")}</h1>
              <p className="text-ink-2">{t("signedOutText")}</p>
            </div>
            <GoogleSignIn action={props.signIn} next={`/join/${props.code}`} />
          </>
        )}

        {props.state === "invalid" && (
          <>
            <h1 className="text-2xl">{t("invalidTitle")}</h1>
            <Banner tone="danger" title={t("invalidBannerTitle")}>
              {t("invalidBannerText")}
            </Banner>
            <ButtonLink href="/orgs" icon={<IconArrowRight />}>
              {t("toOrgs")}
            </ButtonLink>
          </>
        )}

        {props.state === "ready" && (
          <>
            <div className="flex flex-col gap-2">
              <p className="text-ink-2">{t("invitedTo")}</p>
              <h1 className="text-[clamp(2rem,1.5rem+2vw,2.75rem)] wrap-anywhere">{props.orgName}</h1>
              <p className="text-ink-2">{t("memberText")}</p>
            </div>
            <form action={props.join}>
              <input type="hidden" name="code" value={props.code} />
              <SubmitButton variant="primary" size="lg" block pendingLabel={t("joining")}>
                {t("join", { org: props.orgName })}
              </SubmitButton>
            </form>
            {props.email && props.switchAccount && (
              <form action={props.switchAccount} className="flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
                <input type="hidden" name="next" value={`/join/${props.code}`} />
                <span>
                  {t.rich("joiningAs", { email: props.email, strong: (chunks) => <strong className="wrap-anywhere">{chunks}</strong> })}
                </span>
                <Button type="submit" variant="ghost" size="sm">
                  {t("switchAccount")}
                </Button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
