import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListRow } from "@/components/ui/ListRow";
import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/utils";
import { formatClock, formatCount, formatElapsed } from "@/lib/format";

export interface StatusData {
  /** Overall health, from the kill switch / failed ticks. */
  health: "ok" | "degraded" | "paused";
  /** All live meetings, named or not. */
  liveCount: number;
  /** Only meetings of orgs that opted in to being shown. */
  liveMeetings: { id: string; startedAt: string; elapsedMs: number; orgName: string }[];
  minutesThisWeek: number;
  meetingsThisWeek: number;
  updatedAt: string;
}

const healthTone: Record<StatusData["health"], "ok" | "alert"> = { ok: "ok", degraded: "alert", paused: "alert" };

/** Public status page. `data` is null when the numbers could not be loaded. */
export function StatusView({ data }: { data: StatusData | null }) {
  const t = useTranslations("status");
  const locale = useLocale();
  const health = data ? { title: t(`health.${data.health}.title`), text: t(`health.${data.health}.text`), tone: healthTone[data.health] } : null;
  return (
    <div className="mx-auto w-full px-gutter max-w-[46rem] flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl wrap-anywhere">{t("title")}</h1>
        <p className="text-ink-2 max-w-[68ch]">{t("intro")}</p>
      </div>

      {!data || !health ? (
        <EmptyState title={t("unavailableTitle")}>
          <p>{t("unavailableText")}</p>
        </EmptyState>
      ) : (
        <>
          <div data-card className="flex flex-wrap items-center gap-4 rounded-lg bg-surface p-6 shadow-panel" role="status">
            <div>
              <p className={cn("text-xl font-semibold", health.tone === "ok" ? "text-green" : "text-red")}>{health.title}</p>
              <p className="text-ink-2">{health.text}</p>
            </div>
          </div>

          <dl className="grid grid-cols-3 gap-4 max-[34rem]:grid-cols-1 [&>div]:border-t [&>div]:border-line [&>div]:pt-4 [&_dd]:mt-1 [&_dd]:font-mono [&_dd]:text-2xl [&_dd]:font-medium [&_dd]:tracking-[-0.02em] [&_dd]:tabular-nums [&_dt]:text-sm [&_dt]:text-ink-2">
            <div>
              <dt>{t("liveNow")}</dt>
              <dd>{data.liveCount}</dd>
            </div>
            <div>
              <dt>{t("meetingsThisWeek")}</dt>
              <dd>{formatCount(data.meetingsThisWeek, locale)}</dd>
            </div>
            <div>
              <dt>{t("minutesThisWeek")}</dt>
              <dd>{formatCount(data.minutesThisWeek, locale)}</dd>
            </div>
          </dl>

          <Panel flush title={t("inProgress")} titleId="live-now">
            {data.liveCount === 0 ? (
              <p className="text-sm text-ink-3 px-6 pb-6">{t("noneLive")}</p>
            ) : data.liveMeetings.length === 0 ? (
              <p className="text-sm text-ink-3 px-6 pb-6">{t("liveHidden", { count: data.liveCount })}</p>
            ) : (
              <ul  aria-labelledby="live-now">
                {data.liveMeetings.map((m) => (
                  <ListRow
                    key={m.id}
                    title={m.orgName}
                    meta={t("started", { time: formatClock(m.startedAt, locale) })}
                    actions={
                      <>
                        <span className="font-mono tabular-nums text-sm text-ink-3">{formatElapsed(m.elapsedMs)}</span>
                        <Badge tone="live">{t("live")}</Badge>
                      </>
                    }
                  />
                ))}
              </ul>
            )}
            {data.liveCount> data.liveMeetings.length && data.liveMeetings.length> 0 && (
              <p className="text-sm text-ink-3 px-6 pb-6">{t("moreHidden", { count: data.liveCount - data.liveMeetings.length })}</p>
            )}
          </Panel>
          <p className="text-sm text-ink-3">{t("updated", { time: formatClock(data.updatedAt, locale) })}</p>
        </>
      )}
    </div>
  );
}
