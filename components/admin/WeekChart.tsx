"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { isoWeek, niceMax, type AdminWeek } from "@/lib/admin/stats";
import { cn } from "@/lib/utils";

/**
 * One measure per week as columns (a small multiple: the two charts share the week axis, never a
 * second y-scale). One series, so no legend: the title names it. Neutral ink (colour is status
 * only); the current, unfinished week is lighter. Hover a column, or focus the chart and use the
 * arrow keys, for its value; the same numbers are in the table under the charts.
 */
export function WeekChart({ title, weeks, measure, valueText }: { title: string; weeks: AdminWeek[]; measure: "meetings" | "users"; valueText: (count: number) => string }) {
  const t = useTranslations("admin");
  const titleId = useId();
  const [active, setActive] = useState<number | null>(null);
  const top = niceMax(Math.max(0, ...weeks.map((w) => w[measure])));
  const last = weeks.length - 1;
  const current = active === null ? null : weeks[active];

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    setActive((i) => {
      if (e.key === "Home") return 0;
      if (e.key === "End") return last;
      const from = i ?? last;
      return Math.max(0, Math.min(last, from + (e.key === "ArrowLeft" ? -1 : 1)));
    });
  };

  return (
    <figure className="flex min-w-0 flex-col gap-3" aria-labelledby={titleId}>
      <figcaption id={titleId} className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-ink">{title}</span>
        {/* The readout: the hovered/focused week, else the latest. Values lead, labels follow. */}
        <span className="text-ink-3" aria-live="polite">
          {(() => {
            const w = current ?? weeks[last];
            if (!w) return null;
            return (
              <>
                <span className="font-medium text-ink tabular-nums">{valueText(w[measure])}</span> · {t("week", { n: isoWeek(w.week) })}
              </>
            );
          })()}
        </span>
      </figcaption>
      <div
        className="relative mt-3 h-36 rounded-md"
        tabIndex={0}
        role="group"
        aria-label={title}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {/* Recessive grid: the baseline, the middle and the top, with clean tick labels. */}
        {[0, 0.5, 1].map((f) => (
          <div key={f} aria-hidden="true" className="pointer-events-none absolute inset-x-0 flex items-center gap-2" style={{ bottom: `calc(${f * 100}% - 0.5px)` }}>
            <span className="h-px flex-1 bg-line" />
            <span className="w-6 translate-y-0 text-right font-mono text-2xs text-ink-3 tabular-nums">{Math.round(top * f)}</span>
          </div>
        ))}
        <div className="absolute inset-y-0 left-0 right-8 flex items-end">
          {weeks.map((w, i) => {
            const v = w[measure];
            const on = active === i;
            return (
              <div
                key={w.week}
                className="flex h-full flex-1 cursor-default items-end justify-center px-[1px]"
                onPointerEnter={() => setActive(i)}
                aria-hidden="true"
              >
                <div
                  className={cn(
                    "w-full max-w-6 rounded-t-[4px] transition-[background-color,height] duration-200 ease-out",
                    i === last ? "bg-ink-3/45" : "bg-ink-2",
                    on && (i === last ? "bg-ink-3/70" : "bg-ink"),
                  )}
                  style={{ height: v > 0 ? `max(2px, ${(v / top) * 100}%)` : 0 }}
                />
              </div>
            );
          })}
        </div>
      </div>
      {/* Week labels: every third, so they fit at 390 px; the readout names every week. */}
      <div aria-hidden="true" className="-mt-1 mr-8 flex font-mono text-2xs text-ink-3">
        {weeks.map((w, i) => (
          <span key={w.week} className={cn("flex-1 text-center tabular-nums", i === active && "text-ink")}>
            {(last - i) % 3 === 0 || i === active ? isoWeek(w.week) : ""}
          </span>
        ))}
      </div>
    </figure>
  );
}
