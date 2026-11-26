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

const healthCopy: Record<StatusData["health"], { title: string; text: string; tone: "ok" | "alert" }> = {
  ok: { title: "Allt fungerar", text: "Transkribering och anteckningar går som de ska.", tone: "ok" },
  degraded: {
    title: "Anteckningarna går långsamt",
    text: "Transkriberingen fungerar, men det tar längre tid än vanligt innan anteckningarna syns i dokumenten.",
    tone: "alert",
  },
  paused: {
    title: "Tjänsten är pausad",
    text: "Nya möten kan inte starta just nu. Pågående möten avslutas och anteckningarna blir klara.",
    tone: "alert",
  },
};

/** Public status page. `data` is null when the numbers could not be loaded. */
export function StatusView({ data }: { data: StatusData | null }) {
  const health = data ? healthCopy[data.health] : null;
  return (
    <div className="mx-auto w-full px-gutter max-w-[46rem] flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl wrap-anywhere">Status</h1>
        <p className="text-ink-2 max-w-[68ch]">
          Simon Says skriver mötesanteckningar live i Google Docs åt föreningar i Linköping. Här syns vad som händer just
          nu. Föreningar visas med namn bara om de själva valt det.
        </p>
      </div>

      {!data || !health ? (
        <EmptyState title="Siffrorna kan inte hämtas just nu">
          <p>Försök igen om en stund. Det påverkar inte pågående möten.</p>
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4 rounded-lg bg-surface p-6 shadow-panel" role="status">
            <div>
              <p className={cn("text-xl font-semibold", health.tone === "ok" ? "text-green" : "text-red")}>{health.title}</p>
              <p className="text-ink-2">{health.text}</p>
            </div>
          </div>

          <dl className="grid grid-cols-3 gap-4 max-[34rem]:grid-cols-1 [&>div]:border-t [&>div]:border-line [&>div]:pt-4 [&_dd]:mt-1 [&_dd]:font-mono [&_dd]:text-2xl [&_dd]:font-medium [&_dd]:tracking-[-0.02em] [&_dd]:tabular-nums [&_dt]:text-sm [&_dt]:text-ink-2">
            <div>
              <dt>Möten just nu</dt>
              <dd>{data.liveCount}</dd>
            </div>
            <div>
              <dt>Möten i veckan</dt>
              <dd>{formatCount(data.meetingsThisWeek)}</dd>
            </div>
            <div>
              <dt>Minuter i veckan</dt>
              <dd>{formatCount(data.minutesThisWeek)}</dd>
            </div>
          </dl>

          <Panel flush title="Pågår just nu" titleId="live-now">
            {data.liveCount === 0 ? (
              <p className="text-sm text-ink-3 px-6 pb-6">Inga möten pågår just nu.</p>
            ) : data.liveMeetings.length === 0 ? (
              <p className="text-sm text-ink-3 px-6 pb-6">
                {data.liveCount === 1 ? "Ett möte pågår" : `${data.liveCount} möten pågår`}. Föreningarna har inte valt att
                visas.
              </p>
            ) : (
              <ul  aria-labelledby="live-now">
                {data.liveMeetings.map((m) => (
                  <ListRow
                    key={m.id}
                    title={m.orgName}
                    meta={`Startade ${formatClock(m.startedAt)}`}
                    actions={
                      <>
                        <span className="font-mono tabular-nums text-sm text-ink-3">{formatElapsed(m.elapsedMs)}</span>
                        <Badge tone="live">Pågår</Badge>
                      </>
                    }
                  />
                ))}
              </ul>
            )}
            {data.liveCount> data.liveMeetings.length && data.liveMeetings.length> 0 && (
              <p className="text-sm text-ink-3 px-6 pb-6">Och {data.liveCount - data.liveMeetings.length} till som inte visas med namn.</p>
            )}
          </Panel>
          <p className="text-sm text-ink-3">Uppdaterad {formatClock(data.updatedAt)}.</p>
        </>
      )}
    </div>
  );
}
