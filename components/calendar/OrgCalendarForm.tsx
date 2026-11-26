"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { Field } from "@/components/ui/Field";
import { IconCheck } from "@/components/ui/icons";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ConnectCalendarButton } from "./CalendarConnect";

export interface CalendarOption {
  id: string;
  name: string;
}

/**
 * Inställningar → "Mötenas kalender" (admins, todo #14): which of the admin's own calendars holds
 * the förening's meetings, and an optional title filter. The admin connects their calendar first.
 */
export function OrgCalendarForm({
  orgId,
  connected,
  calendars,
  current,
  save,
  connect,
}: {
  orgId: string;
  connected: boolean;
  /** The admin's calendars; null when they couldn't be read (connected) or not connected. */
  calendars: CalendarOption[] | null;
  current: { id: string | null; name: string | null; filter: string | null };
  save: FormAction;
  connect: FormAction;
}) {
  const t = useTranslations("calendar");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [saved]);

  const options = calendars ? [...calendars] : [];
  // The chosen calendar stays choosable even when it is not in this admin's list.
  if (current.id && !options.some((c) => c.id === current.id)) options.unshift({ id: current.id, name: current.name ?? current.id });

  return (
    <div className="flex max-w-[40rem] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">{t("orgTitle")}</h3>
        <p className="text-sm text-ink-2">{t("orgIntro")}</p>
      </div>
      {current.name && !connected && <p className="text-sm">{t("orgCurrent", { name: current.name })}</p>}
      {!connected ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-3">{t("orgConnectFirst")}</p>
          <div>
            <ConnectCalendarButton action={connect} back={`/orgs/${orgId}`} />
          </div>
        </div>
      ) : calendars === null ? (
        <Banner tone="warning">{t("orgUnavailable")}</Banner>
      ) : (
        <form
          className="flex flex-col gap-4"
          action={async (form) => {
            setSaved(false);
            await save(form);
            setSaved(true);
          }}
          onChange={() => setSaved(false)}
        >
          <input type="hidden" name="orgId" value={orgId} />
          {options.length === 0 && <p className="text-sm text-ink-3">{t("orgNoShared")}</p>}
          <div className="flex flex-col gap-2">
            <Label htmlFor="org-calendar">{t("calendarLabel")}</Label>
            <NativeSelect id="org-calendar" name="calendar_id" defaultValue={current.id ?? ""} className="w-full">
              <option value="">{t("none")}</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Field
            id="org-calendar-filter"
            name="calendar_filter"
            label={t("filterLabel")}
            hint={t("filterHint")}
            defaultValue={current.filter ?? ""}
            maxLength={60}
            autoComplete="off"
          />
          <div className="flex items-center gap-3">
            <SubmitButton variant="secondary" pendingLabel={t("saving")}>
              {t("save")}
            </SubmitButton>
            {saved && (
              <span role="status" className="inline-flex items-center gap-1 text-sm text-green">
                <IconCheck size={16} />
                {t("saved")}
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
