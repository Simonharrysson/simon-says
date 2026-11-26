import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { IconCheck } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export interface NameRoundEntry {
  key: string;
  /** "Talare 2" */
  label: string;
  /** Name heard so far, or null while we wait. */
  name: string | null;
  needsConfirm: boolean;
}

/**
 * Right after Start: everyone says "Jag heter …" in turn. Voices show up as they're heard
 * ("Talare 2 …"); the names are read from what was said when "Klar" is pressed (or by the
 * server after about two minutes). "Hoppa över" for a meeting where everyone is already known.
 * While it runs, this is the only list of names on the page (the speaker list waits).
 */
export function NameRound({
  entries,
  onDone,
  onSkip,
  busy,
}: {
  entries: NameRoundEntry[];
  onDone: () => void;
  onSkip?: () => void;
  /** "Klar" was pressed: the names are being read. */
  busy?: boolean;
}) {
  const t = useTranslations("live.nameRound");
  const heard = entries;
  return (
    <section className="flex flex-col gap-4 rounded-lg bg-surface p-6 shadow-[inset_0_0_0_1px_var(--blue)]" aria-labelledby="nameround-title">
      <div className="flex flex-col gap-1">
        <h2 id="nameround-title" className="text-xl">
          {t("title")}
        </h2>
        <p className="text-lg font-semibold [&_q]:[quotes:'”'_'”']">
          {t.rich("say", { q: (chunks) => <q>{chunks}</q> })}
        </p>
        <p className="text-ink-2">{t("why")}</p>
      </div>
      <ol className="flex flex-wrap gap-2" aria-live="polite" aria-label={t("heard")}>
        {heard.length === 0 && <li className="text-sm text-ink-3">{t("waiting")}</li>}
        {heard.map((entry) => (
          <li key={entry.key} className="inline-flex animate-plate-in items-center gap-2 rounded-md bg-sunk px-[0.8rem] py-[0.4rem]">
            <span className={cn("font-semibold", entry.needsConfirm && "text-blue")}>
              {entry.name ?? "…"}
              {entry.name && entry.needsConfirm && "?"}
            </span>
            <span className="text-xs text-ink-3">{entry.label}</span>
          </li>
        ))}
      </ol>
      {heard.some((e) => e.name && e.needsConfirm) && (
        <p className="text-sm text-ink-3">{t("fixLater")}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={<IconCheck />} onClick={onDone} disabled={busy}>
          {busy ? t("reading") : t("done")}
        </Button>
        {onSkip && (
          <Button variant="ghost" onClick={onSkip}>
            {t("skip")}
          </Button>
        )}
      </div>
    </section>
  );
}
