import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListRow } from "@/components/ui/ListRow";
import { Panel } from "@/components/ui/Panel";
import { formatClock, formatElapsed } from "@/lib/format";

export interface StatusData {
  /** Overall health, from the kill switch / failed ticks. */
  health: "ok" | "degraded" | "paused";
  liveMeetings: { id: string; startedAt: string; elapsedMs: number; orgName: string | null }[];
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

/** Public status page. `data` is null until Task 13 wires the numbers. */
export function StatusView({ data }: { data: StatusData | null }) {
  const health = data ? healthCopy[data.health] : null;
  return (
    <div className="page page--read stack" style={{ ["--stack-gap" as string]: "2rem" }}>
      <div className="stack" style={{ ["--stack-gap" as string]: "0.75rem" }}>
        <h1 className="page-header__title">Status</h1>
        <p className="muted measure">
          Simon Says skriver mötesanteckningar live i Google Docs åt föreningar i Linköping. Här syns vad som händer just
          nu. Föreningar visas med namn bara om de själva valt det.
        </p>
      </div>

      {!data || !health ? (
        <EmptyState title="Siffrorna kommer snart">
          <p>Statussidan är ett utkast. När den är kopplad visas pågående möten och veckans minuter här.</p>
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
              <dd>{data.liveMeetings.length}</dd>
            </div>
            <div>
              <dt>Möten i veckan</dt>
              <dd>{data.meetingsThisWeek}</dd>
            </div>
            <div>
              <dt>Minuter i veckan</dt>
              <dd>{data.minutesThisWeek.toLocaleString("sv-SE")}</dd>
            </div>
          </dl>

          <Panel flush title="Pågår just nu" titleId="live-now">
            {data.liveMeetings.length === 0 ? (
              <p className="subtle panel-pad">Inga möten pågår just nu.</p>
            ) : (
              <ul className="list" aria-labelledby="live-now">
                {data.liveMeetings.map((m) => (
                  <ListRow
                    key={m.id}
                    title={m.orgName ?? "En förening"}
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
          </Panel>
          <p className="subtle">Uppdaterad {formatClock(data.updatedAt)}.</p>
        </>
      )}
    </div>
  );
}
