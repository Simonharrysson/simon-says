import { useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";

// The MCP consent page (/koppla/<id>): who asks, what Claude will and won't be able to do, and
// Godkänn / Avbryt. The client's name is whatever it registered: the redirect host is shown next
// to it so a look-alike can be told apart.

export function ConnectView({
  requestId,
  clientName,
  host,
  email,
  allowed,
  approve,
  deny,
}: {
  requestId: string;
  clientName: string;
  host: string;
  email: string;
  /** On the allow-list (lib/foretag/gate.ts); otherwise only Avbryt. */
  allowed: boolean;
  approve: FormAction;
  deny: FormAction;
}) {
  const t = useTranslations("connect");
  return (
    <div className="mx-auto w-full px-gutter max-w-[36rem] flex flex-col gap-6">
      <PageHeader title={t("title")} />
      <Panel>
        <div className="flex flex-col gap-4">
          <p className="text-ink-2">
            {t("requestFrom", { client: clientName, host })} {t("signedInAs", { email })}
          </p>
          {allowed ? (
            <>
              <div>
                <h2 className="text-sm font-semibold">{t("canTitle")}</h2>
                <ul className="mt-2 list-disc pl-5 text-ink-2 flex flex-col gap-1">
                  <li>{t("canSearch")}</li>
                  <li>{t("canTasks")}</li>
                  <li>{t("canAgenda")}</li>
                </ul>
              </div>
              <div>
                <h2 className="text-sm font-semibold">{t("cannotTitle")}</h2>
                <ul className="mt-2 list-disc pl-5 text-ink-2 flex flex-col gap-1">
                  <li>{t("cannotEdit")}</li>
                  <li>{t("cannotMore")}</li>
                </ul>
              </div>
              <p className="text-sm text-ink-3">{t("revokeHint")}</p>
            </>
          ) : (
            <Banner tone="info" title={t("notOpenTitle")} live={false}>
              {t("notOpenText")}
            </Banner>
          )}
          <div className="flex flex-wrap gap-3">
            {allowed && (
              <form action={approve}>
                <input type="hidden" name="request" value={requestId} />
                <SubmitButton variant="primary" pendingLabel={t("approving")}>
                  {t("approve")}
                </SubmitButton>
              </form>
            )}
            <form action={deny}>
              <input type="hidden" name="request" value={requestId} />
              <Button type="submit">{t("deny")}</Button>
            </form>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/** An expired request, or one that could not start. */
export function ConnectMessage({ kind }: { kind: "expired" | "errorClient" | "errorRedirect" }) {
  const t = useTranslations("connect");
  return (
    <div className="mx-auto w-full px-gutter max-w-[36rem] flex flex-col gap-6">
      <PageHeader title={kind === "expired" ? t("expiredTitle") : t("errorTitle")} />
      <Banner tone="warning" live={false}>
        {kind === "expired" ? t("expiredText") : t(kind)}
      </Banner>
    </div>
  );
}
