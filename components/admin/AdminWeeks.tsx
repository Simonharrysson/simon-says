"use client";

import { useLocale, useTranslations } from "next-intl";
import { isoWeek, type AdminWeek } from "@/lib/admin/stats";
import { intlTag, toLocale } from "@/lib/i18n/config";
import { WeekChart } from "./WeekChart";

/** Meetings and new accounts per week: two small multiples on one week axis, plus the table view. */
export function AdminWeeks({ weeks }: { weeks: AdminWeek[] }) {
  const t = useTranslations("admin");
  const locale = toLocale(useLocale());
  const day = new Intl.DateTimeFormat(intlTag(locale), { timeZone: "UTC", day: "numeric", month: "short" });
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-x-10 gap-y-8 max-[52rem]:grid-cols-1">
        <WeekChart title={t("chartMeetings")} weeks={weeks} measure="meetings" valueText={(count) => t("barMeetings", { count })} />
        <WeekChart title={t("chartUsers")} weeks={weeks} measure="users" valueText={(count) => t("barUsers", { count })} />
      </div>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer text-ink-2 hover:text-ink">{t("showTable")}</summary>
        <table className="mt-3 w-full max-w-md border-collapse">
          <thead>
            <tr className="text-left text-ink-3">
              <th scope="col" className="py-2 pr-3 font-medium">{t("colWeek")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{t("colMeetings")}</th>
              <th scope="col" className="py-2 text-right font-medium">{t("colUsers")}</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.week}>
                <td className="border-t border-line py-2 pr-3">{t("weekOf", { n: isoWeek(w.week), date: day.format(new Date(`${w.week}T00:00:00Z`)) })}</td>
                <td className="border-t border-line py-2 pr-3 text-right font-mono tabular-nums">{w.meetings}</td>
                <td className="border-t border-line py-2 text-right font-mono tabular-nums">{w.users}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
