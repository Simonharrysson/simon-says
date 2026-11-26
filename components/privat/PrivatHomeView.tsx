import { useLocale, useTranslations } from "next-intl";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconArrowRight, IconMic } from "@/components/ui/icons";
import { ListRow } from "@/components/ui/ListRow";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/badge";
import { NoticeBanner } from "@/components/views/NoticeBanner";
import { shortWhen } from "@/lib/privat/format";
import type { Notice } from "@/lib/ui/messages";

export interface PrivatHomeContext {
  id: string;
  name: string;
  openTasks: number;
  recordings: number;
  lastAt: string | null;
}

/**
 * /privat: the user's own space. "Spela in" (the live engine, no Google Doc by default), the
 * contexts with their open tasks, and a running recording on top. Only the user sees any of it.
 */
export function PrivatHomeView({
  startHref,
  contexts,
  running,
  notice,
}: {
  startHref: string;
  contexts: PrivatHomeContext[];
  /** A recording that is live or finishing: back to its page. */
  running: { href: string; label: string } | null;
  notice: Notice | null;
}) {
  const t = useTranslations("privat.home");
  const locale = useLocale() === "en" ? "en" : "sv";
  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-8 px-gutter">
      <PageHeader
        title={t("title")}
        meta={
          <p className="max-w-[34rem] text-ink-2">{t("intro")}</p>
        }
        actions={
          !running && (
            <ButtonLink href={startHref} variant="primary" size="lg" icon={<IconMic />} className="max-sm:w-full">
              {t("start")}
            </ButtonLink>
          )
        }
      />
      <NoticeBanner notice={notice} />

      {running && (
        <Panel title={t("runningTitle")} titleId="running-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-ink-2">{running.label}</p>
            <ButtonLink href={running.href} variant="primary">
              {t("toRecording")}
            </ButtonLink>
          </div>
        </Panel>
      )}

      {contexts.length === 0 ? (
        <EmptyState title={t("emptyTitle")}>
          <p>{t("emptyText")}</p>
        </EmptyState>
      ) : (
        <Panel flush title={t("contextsTitle")} titleId="contexts-title">
          <ul aria-labelledby="contexts-title">
            {contexts.map((c) => (
              <ListRow
                key={c.id}
                href={`/privat/${c.id}`}
                title={c.name}
                meta={
                  c.recordings
                    ? c.lastAt
                      ? t("recordingsLast", { count: c.recordings, when: shortWhen(c.lastAt, locale) })
                      : t("recordings", { count: c.recordings })
                    : t("noRecordings")
                }
                actions={
                  <>
                    {c.openTasks > 0 && <Badge tone="info">{t("openTasks", { count: c.openTasks })}</Badge>}
                    <IconArrowRight size={18} className="text-ink-3 transition-transform duration-120 ease-out group-hover/row:translate-x-[3px] group-hover/row:text-ink" />
                  </>
                }
              />
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
