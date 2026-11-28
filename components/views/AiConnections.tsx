import { useFormatter, useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import type { LogoId } from "@/components/ui/BrandLogo";
import { TOOL_NAMES } from "@/lib/mcp/clients";
import type { Audience } from "@/lib/mcp/oauth";
import type { AuditEntry, ConnectionRow } from "@/lib/mcp/account";
import { AddAnother, ConnectPicker, ToolMark } from "./ConnectAi";

// Konto → Koppla till din AI: what is connected (each with Koppla från), then the tiles to
// connect a tool (behind "Koppla en till" once something is connected), then the recent calls
// (tool and time only). docs/mcp.md has the steps per tool.

/** The app's mark: from the redirect URI the grant was approved for, never from the client's own name. */
const LOGO: Record<Audience, LogoId> = { claude: "claude", chatgpt: "chatgpt", cursor: "cursor", vscode: "vscode", local: "local", unknown: "unknown" };

export function AiConnections({
  connections,
  audit,
  revoke,
  revokeFailed,
  mcpUrl,
}: {
  connections: ConnectionRow[];
  audit: AuditEntry[];
  revoke: FormAction;
  revokeFailed?: boolean;
  /** The server's address, to paste into the tools. */
  mcpUrl: string;
}) {
  const t = useTranslations("connect");
  const format = useFormatter();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const picker = <ConnectPicker mcpUrl={mcpUrl} />;
  const appName = (app: Audience) => (app === "local" ? t("appLocalShort") : app === "unknown" ? t("appUnknown") : TOOL_NAMES[app]);
  return (
    <div className="flex flex-col gap-6">
      <p className="text-ink-2 max-w-[68ch]">{t("panelIntro")}</p>
      {revokeFailed && (
        <Banner tone="warning" live={false}>
          {t("revokeFailed")}
        </Banner>
      )}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t("connectedTitle")}</h3>
        {connections.length === 0 ? (
          <p className="text-ink-3">{t("panelEmpty")}</p>
        ) : (
          <ul aria-label={t("connectedTitle")} className="flex flex-col divide-y divide-line">
            {connections.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-1">
                <ToolMark logo={LOGO[c.app]} className="bg-sunk" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{appName(c.app)}</span>
                  {/* The name the client gave itself: its own claim, so only secondary. */}
                  <span className="text-sm text-ink-3 wrap-anywhere">{t("registeredAs", { client: c.client_name })}</span>
                  <span className="text-sm text-ink-3">
                    {t("connectedAt", { date: when(c.created_at) })} · {c.last_used_at ? t("lastUsed", { date: when(c.last_used_at) }) : t("neverUsed")}
                  </span>
                </div>
                <ConfirmAction
                  action={revoke}
                  hidden={{ grant: c.id }}
                  trigger={t("revoke")}
                  title={t("revokeTitle", { client: c.app === "local" || c.app === "unknown" ? c.client_name : appName(c.app) })}
                  description={t("revokeConfirm", { client: c.app === "local" || c.app === "unknown" ? c.client_name : appName(c.app) })}
                  confirmLabel={t("revoke")}
                  pendingLabel={t("revoking")}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {connections.length > 0 ? <AddAnother>{picker}</AddAnother> : picker}
      {audit.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">{t("auditTitle")}</h3>
          <p className="text-sm text-ink-3">{t("auditIntro")}</p>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {audit.map((a) => (
              <li key={a.id} className="flex gap-3">
                <span className="text-ink-3 tabular-nums">{when(a.at)}</span>
                <code>{a.tool}</code>
                {!a.ok && <span className="text-red">{t("auditFailed")}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
