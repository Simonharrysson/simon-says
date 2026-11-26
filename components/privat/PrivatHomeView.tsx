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
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-8 px-gutter">
      <PageHeader
        title="Privat"
        meta={
          <p className="max-w-[34rem] text-ink-2">
            Spela in möten, föreläsningar och samtal. Efter varje inspelning får du en sammanfattning på mejlen, och här samlas
            uppgifter och beslut per sammanhang. Bara du ser det.
          </p>
        }
        actions={
          !running && (
            <ButtonLink href={startHref} variant="primary" size="lg" icon={<IconMic />} className="max-sm:w-full">
              Spela in
            </ButtonLink>
          )
        }
      />
      <NoticeBanner notice={notice} />

      {running && (
        <Panel title="Pågår" titleId="running-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-ink-2">{running.label}</p>
            <ButtonLink href={running.href} variant="primary">
              Till inspelningen
            </ButtonLink>
          </div>
        </Panel>
      )}

      {contexts.length === 0 ? (
        <EmptyState title="Inga inspelningar än">
          <p>
            Tryck Spela in och välj vad det gäller, till exempel en kurskod eller ett projekt. Sammanfattningen kommer på mejlen
            ungefär en minut efter att du avslutat.
          </p>
        </EmptyState>
      ) : (
        <Panel flush title="Sammanhang" titleId="contexts-title">
          <ul aria-labelledby="contexts-title">
            {contexts.map((c) => (
              <ListRow
                key={c.id}
                href={`/privat/${c.id}`}
                title={c.name}
                meta={
                  c.recordings
                    ? `${plural(c.recordings, "inspelning", "inspelningar")}${c.lastAt ? ` · senast ${shortWhen(c.lastAt)}` : ""}`
                    : "Inga inspelningar än"
                }
                actions={
                  <>
                    {c.openTasks > 0 && <Badge tone="info">{plural(c.openTasks, "öppen uppgift", "öppna uppgifter")}</Badge>}
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
