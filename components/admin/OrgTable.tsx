"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { IconChevronDown } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { filterSortOrgs, type AdminOrgRow, type OrgKind, type SortDir, type SortKey } from "@/lib/admin/stats";
import { intlTag, TIME_ZONE, toLocale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

const NUMERIC: SortKey[] = ["members", "meetings", "lastMeetingAt", "createdAt"];

/** Every org with its counts: search by name, filter by kind, sort by any column. */
export function OrgTable({ rows }: { rows: AdminOrgRow[] }) {
  const t = useTranslations("admin");
  const locale = toLocale(useLocale());
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<OrgKind | "all">("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "lastMeetingAt", dir: "desc" });
  const deferredQuery = useDeferredValue(query);
  const shown = useMemo(() => filterSortOrgs([...rows], { query: deferredQuery, kind, ...sort }, locale), [rows, deferredQuery, kind, sort, locale]);
  const date = useMemo(() => new Intl.DateTimeFormat(intlTag(locale), { timeZone: TIME_ZONE, day: "numeric", month: "short", year: "numeric" }), [locale]);
  const num = useMemo(() => new Intl.NumberFormat(intlTag(locale)), [locale]);

  const columns: { key: SortKey; label: string; className?: string }[] = [
    { key: "name", label: t("colName"), className: "md:min-w-44" },
    // At phone width the kind and the last meeting sit under the name and Skapad is left out, so
    // the counts fit without scrolling sideways.
    { key: "kind", label: t("colKind"), className: "max-md:hidden" },
    { key: "members", label: t("colMembers"), className: "text-right max-md:px-2" },
    { key: "meetings", label: t("colOrgMeetings"), className: "text-right max-md:pr-6" },
    { key: "lastMeetingAt", label: t("colLast"), className: "max-md:hidden" },
    { key: "createdAt", label: t("colCreated"), className: "max-md:hidden" },
  ];

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: NUMERIC.includes(key) ? "desc" : "asc" }));

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 px-6 pb-4">
        <label className="min-w-0 flex-[1_1_16rem]">
          <span className="sr-only">{t("search")}</span>
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search")} autoComplete="off" />
        </label>
        <label className="flex-[0_1_12rem]">
          <span className="sr-only">{t("kindFilter")}</span>
          <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as OrgKind | "all")}>
            <option value="all">{t("kindAll")}</option>
            <option value="forening">{t("kind.forening")}</option>
            <option value="foretag">{t("kind.foretag")}</option>
            <option value="privat">{t("kind.privat")}</option>
          </NativeSelect>
        </label>
        <p className="ml-auto text-sm text-ink-3 tabular-nums" aria-live="polite">
          {t("shown", { shown: shown.length, total: rows.length })}
        </p>
      </div>
      {/* Its own scroll box: at 390 px the table scrolls sideways, never the page. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-ink-3">
              {columns.map((c) => {
                const on = sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                    className={cn("border-t border-line px-3 py-0 font-medium whitespace-nowrap first:pl-6 last:pr-6", c.className)}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(c.key)}
                      title={t("sortBy", { column: c.label })}
                      className={cn(
                        "inline-flex min-h-10 items-center gap-1 rounded-sm transition-colors duration-120 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:scale-[0.98]",
                        on && "text-ink",
                        c.className?.includes("text-right") && "flex-row-reverse",
                      )}
                    >
                      {c.label}
                      <IconChevronDown
                        size={14}
                        aria-hidden="true"
                        className={cn("transition-[transform,opacity] duration-200 ease-out", on ? "opacity-100" : "opacity-0", on && sort.dir === "asc" && "rotate-180")}
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="transition-colors duration-120 hover:bg-sunk/60">
                <td className="max-w-80 border-t border-line py-3 pr-3 pl-6 font-medium text-ink max-md:max-w-none max-md:min-w-40">
                  <span className="block wrap-anywhere md:truncate" title={r.name}>
                    {r.name}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal text-ink-3 md:hidden">
                    <Badge tone={r.kind === "foretag" ? "info" : "neutral"}>{t(`kind.${r.kind}`)}</Badge>
                    <span className="tabular-nums">{r.lastMeetingAt ? date.format(new Date(r.lastMeetingAt)) : t("never")}</span>
                  </span>
                </td>
                <td className="border-t border-line px-3 py-3 max-md:hidden">
                  <Badge tone={r.kind === "foretag" ? "info" : "neutral"}>{t(`kind.${r.kind}`)}</Badge>
                </td>
                <td className="border-t border-line px-3 py-3 text-right font-mono tabular-nums max-md:px-2">{num.format(r.members)}</td>
                <td className="border-t border-line px-3 py-3 text-right font-mono tabular-nums max-md:pr-6">{num.format(r.meetings)}</td>
                <td className={cn("border-t border-line px-3 py-3 whitespace-nowrap tabular-nums max-md:hidden", !r.lastMeetingAt && "text-ink-3")}>
                  {r.lastMeetingAt ? date.format(new Date(r.lastMeetingAt)) : t("never")}
                </td>
                <td className="border-t border-line py-3 pr-6 pl-3 whitespace-nowrap text-ink-2 tabular-nums max-md:hidden">{r.createdAt ? date.format(new Date(r.createdAt)) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <p className="border-t border-line px-6 py-6 text-sm text-ink-3">{rows.length === 0 ? t("noOrgs") : t("empty")}</p>}
      <div className="h-2" aria-hidden="true" />
    </>
  );
}
