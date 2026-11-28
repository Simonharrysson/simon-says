import { useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { Audience } from "@/lib/mcp/oauth";

// The MCP consent page (/koppla/<id>): where the access goes (the redirect host, prominently),
// what the app will and won't be able to do, and Godkänn / Avbryt. The app is named from the
// redirect URI (lib/mcp/oauth.ts redirectAudience), never from the name the client registered.

const APP_LABEL = {
  claude: "appClaude",
  chatgpt: "appChatgpt",
  cursor: "appCursor",
  vscode: "appVscode",
  local: "appLocal",
  unknown: "appUnknown",
} as const satisfies Record<Audience, string>;

export function ConnectView({
  requestId,
  audience,
  host,
  email,
  allowed,
  approve,
  deny,
}: {
  requestId: string;
  /** From the redirect URI: a known hosted callback (Claude, ChatGPT, Cursor, VS Code), a loopback app, or (never registrable) unknown. */
  audience: Audience;
  host: string;
  email: string;
  /** MCP is on (MCP_ENABLED); otherwise only Avbryt. */
  allowed: boolean;
  approve: FormAction;
  deny: FormAction;
}) {
  const t = useTranslations("connect");
  const app = t(APP_LABEL[audience]);
  const can = allowed && audience !== "unknown";
  return (
    <div className="mx-auto w-full px-gutter max-w-[36rem] flex flex-col gap-6">
      <PageHeader title={t("title", { app })} />
      <Panel>
        <div className="flex flex-col gap-4">
          <p className="text-lg font-semibold wrap-anywhere">{t("accessTo", { host })}</p>
          <p className="text-ink-2">{t("signedInAs", { email })}</p>
          {audience === "local" && (
            <Banner tone="warning" live={false}>
              {t("localWarning")}
            </Banner>
          )}
          {audience === "unknown" ? (
            <Banner tone="danger" live={false}>
              {t("unknownWarning")}
            </Banner>
          ) : allowed ? (
            <>
              <div>
                <h2 className="text-sm font-semibold first-letter:uppercase">{t("canTitle", { app })}</h2>
                <ul className="mt-2 list-disc pl-5 text-ink-2 flex flex-col gap-1">
                  <li>{t("canSearch")}</li>
                  <li>{t("canTasks")}</li>
                  <li>{t("canAgenda")}</li>
                </ul>
              </div>
              <div>
                <h2 className="text-sm font-semibold first-letter:uppercase">{t("cannotTitle", { app })}</h2>
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
            {can && (
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
