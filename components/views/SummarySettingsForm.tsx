"use client";

import { useTranslations } from "next-intl";
import { Checkbox } from "@/components/ui/checkbox";
import { hintClass } from "@/components/ui/Field";
import { SaveState, useSavedValue } from "@/components/settings/SaveState";
import { saveSummaryAction, type SettingResult } from "@/app/(app)/orgs/settings-actions";
import type { SummaryMode } from "@/lib/db/types";
import { cn } from "@/lib/utils";

export interface SummaryPersonOption {
  id: string;
  name: string;
  role?: string | null;
  /** Has an address (their own e-mail, or a linked member account). */
  hasEmail: boolean;
  selected: boolean;
}

const MODES: SummaryMode[] = ["missed", "all", "selected", "off"];

/**
 * Inställningar → Efter mötet: "Sammanfattning efter mötet" (0037, admins). After a meeting Simon
 * Says mails its decisions and tasks; this picks who gets them. Every choice saves at once (the
 * settings' save model): the whole setting, mode and people, goes with each change.
 */
export function SummarySettingsForm({
  orgId,
  mode: savedMode,
  people,
  save: saveSetting = saveSummaryAction,
}: {
  orgId: string;
  mode: SummaryMode;
  people: SummaryPersonOption[];
  /** The save (`saveSummaryAction`); the /design gallery passes its own. */
  save?: (orgId: string, mode: SummaryMode, personIds: string[]) => Promise<SettingResult>;
}) {
  const t = useTranslations("summary");
  const server = { mode: savedMode, people: people.filter((p) => p.selected).map((p) => p.id) };
  const setting = useSavedValue(server, async (v) => {
    const r = await saveSetting(orgId, v.mode, v.people);
    return r.ok ? null : r.message;
  });
  const { mode, people: chosen } = setting.value;
  const status = setting.status;
  const withEmail = people.filter((p) => p.hasEmail).length;
  const save = (nextMode: SummaryMode, nextPeople: string[]) => setting.change({ mode: nextMode, people: nextPeople });

  return (
    <div className="flex max-w-[40rem] flex-col gap-5">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-medium">{t("legend")}</legend>
        <p className="mb-2 text-sm text-ink-2">{t("intro")}</p>
        {MODES.map((m) => {
          const o = { mode: m, title: t(`modes.${m}.title`), hint: t(`modes.${m}.hint`) };
          const checked = mode === o.mode;
          return (
            <label
              key={o.mode}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border bg-surface p-4 transition-colors duration-120",
                checked ? "border-ink" : "border-line hover:border-control",
              )}
            >
              <input
                type="radio"
                name="summary_mode"
                value={o.mode}
                checked={checked}
                onChange={() => save(o.mode, chosen)}
                className="mt-1 size-4 accent-[var(--ink)]"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{o.title}</span>
                <span className={hintClass}>{o.hint}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {mode === "selected" ? (
        <fieldset className="flex flex-col">
          <legend className="mb-2 text-sm font-medium">{t("whoLegend")}</legend>
          {people.length === 0 ? (
            <p className="text-sm text-ink-3">{t("emptyList")}</p>
          ) : (
            <ul className="flex flex-col rounded-lg border border-line bg-surface">
              {people.map((p) => {
                const id = `summary-person-${p.id}`;
                const note = !p.hasEmail ? t("noEmail") : null;
                return (
                  <li key={p.id} className="border-t border-line first:border-t-0">
                    <label htmlFor={id} className={cn("flex min-h-11 items-center gap-3 px-4 py-2", p.hasEmail ? "cursor-pointer" : "cursor-not-allowed")}>
                      <Checkbox
                        id={id}
                        checked={chosen.includes(p.id)}
                        disabled={!p.hasEmail}
                        onCheckedChange={(v) => save(mode, v === true ? [...chosen, p.id] : chosen.filter((x) => x !== p.id))}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium wrap-anywhere">
                          {p.name}
                          {p.role && <span className="font-normal text-ink-3"> · {p.role}</span>}
                        </span>
                        {note && <span className={hintClass}>{note}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      ) : (
        mode !== "off" && (
          <p className="text-sm text-ink-3">
            {withEmail === 0 ? t("noneWithEmail") : t("withEmail", { count: withEmail })}
          </p>
        )
      )}
      <SaveState status={status} />
    </div>
  );
}
