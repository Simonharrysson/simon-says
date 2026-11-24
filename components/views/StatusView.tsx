import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListRow } from "@/components/ui/ListRow";
import { Panel } from "@/components/ui/Panel";
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

const healthCopy: Record<StatusData["health"], { title: string; text: string; magnet: string }> = {
  ok: { title: "Allt fungerar", text: "Transkribering och anteckningar går som de ska.", magnet: "magnet magnet--green" },
  degraded: {
    title: "Anteckningarna går långsamt",
    text: "Transkriberingen fungerar, men det tar längre tid än vanligt innan anteckningarna syns i dokumenten.",
    magnet: "magnet",
  },
  paused: {
    title: "Tjänsten är pausad",
    text: "Nya möten kan inte starta just nu. Pågående möten avslutas och anteckningarna blir klara.",
    magnet: "magnet",
  },
};

/** Public status page. `data` is null when the numbers could not be loaded. */
export function StatusView({ data }: { data: StatusData | null }) {
  const health = data ? healthCopy[data.health] : null;
  return (
    <div className="page page--read stack stack--6">
      <div className="stack stack--3">
        <h1 className="page-header__title">Status</h1>
        <p className="muted measure">
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
          <div className="status-hero" role="status">
            <span className={`${health.magnet} status-hero__light`} aria-hidden="true" />
            <div>
              <p className="status-hero__title">{health.title}</p>
              <p className="muted">{health.text}</p>
            </div>
          </div>

          <dl className="status-counts">
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
              <p className="subtle panel-pad">Inga möten pågår just nu.</p>
            ) : data.liveMeetings.length === 0 ? (
              <p className="subtle panel-pad">
                {data.liveCount === 1 ? "Ett möte pågår" : `${data.liveCount} möten pågår`}. Föreningarna har inte valt att
                visas.
              </p>
            ) : (
              <ul className="list" aria-labelledby="live-now">
                {data.liveMeetings.map((m) => (
                  <ListRow
                    key={m.id}
                    title={m.orgName}
                    meta={`Startade ${formatClock(m.startedAt)}`}
                    actions={
                      <>
                        <span className="mono subtle">{formatElapsed(m.elapsedMs)}</span>
                        <Badge tone="live">Pågår</Badge>
                      </>
                    }
                  />
                ))}
              </ul>
            )}
            {data.liveCount > data.liveMeetings.length && data.liveMeetings.length > 0 && (
              <p className="subtle panel-pad">Och {data.liveCount - data.liveMeetings.length} till som inte visas med namn.</p>
            )}
          </Panel>
          <p className="subtle">Uppdaterad {formatClock(data.updatedAt)}.</p>
        </>
      )}
    </div>
  );
}
