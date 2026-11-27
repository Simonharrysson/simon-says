import { useFormatter, useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import type { AuditEntry, ConnectionRow } from "@/lib/mcp/account";

// Konto → Kopplade AI-assistenter: each connected assistant with Återkalla, and the recent calls
// (tool and time only). docs/mcp.md has the "Lägg till i Claude" steps.

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
  /** The server's address, for the "Lägg till i Claude" line. */
  mcpUrl: string;
}) {
  const t = useTranslations("connect");
  const format = useFormatter();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-2 max-w-[68ch]">{t("panelIntro")}</p>
      {revokeFailed && (
        <Banner tone="warning" live={false}>
          {t("revokeFailed")}
        </Banner>
      )}
      {connections.length === 0 ? (
        <p className="text-ink-3">{t("panelEmpty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {connections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="flex flex-col">
                <span className="font-medium wrap-anywhere">{c.client_name}</span>
                <span className="text-sm text-ink-3">
                  {t("connectedAt", { date: when(c.created_at) })} · {c.last_used_at ? t("lastUsed", { date: when(c.last_used_at) }) : t("neverUsed")}
                </span>
              </div>
              <ConfirmAction
                action={revoke}
                hidden={{ grant: c.id }}
                trigger={t("revoke")}
                title={t("revoke")}
                description={t("revokeConfirm", { client: c.client_name })}
                confirmLabel={t("revoke")}
                pendingLabel={t("revoking")}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-ink-2 wrap-anywhere">{t("panelHowTo", { url: mcpUrl })}</p>
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
