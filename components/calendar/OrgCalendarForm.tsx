"use client";

import { useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/button";
import { SaveState, useSavedValue } from "@/components/settings/SaveState";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
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
  /** `saveOrgCalendarResult`: the outcome comes back (no redirect). */
  save: (orgId: string, calendarId: string, filter: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  connect: FormAction;
}) {
  const t = useTranslations("calendar");
  // The settings' save model: the calendar saves when chosen; the title filter (text) with Spara.
  // A choice sends the *saved* filter, never a half-typed one. Kept by key: the form streams in
  // under <Suspense> and may be re-mounted by the save's own refresh.
  const setting = useSavedValue(
    { id: current.id ?? "", filter: current.filter ?? "" },
    async (v) => {
      const r = await save(orgId, v.id, v.filter);
      return r.ok ? null : r.message;
    },
    "calendar",
  );
  const status = setting.status;

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
            <ConnectCalendarButton action={connect} back={`/orgs/${orgId}/installningar`} />
          </div>
        </div>
      ) : calendars === null ? (
        <Banner tone="warning">{t("orgUnavailable")}</Banner>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setting.change({ id: setting.value.id, filter: String(new FormData(e.currentTarget).get("calendar_filter") ?? "") });
          }}
        >
          {options.length === 0 && <p className="text-sm text-ink-3">{t("orgNoShared")}</p>}
          <div className="flex flex-col gap-2">
            <Label htmlFor="org-calendar">{t("calendarLabel")}</Label>
            <NativeSelect
              id="org-calendar"
              name="calendar_id"
              value={setting.value.id}
              onChange={(e) => setting.change({ id: e.target.value, filter: setting.confirmed().filter })}
              className="w-full"
            >
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
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" loading={status.state === "saving"}>
              {t("save")}
            </Button>
            <SaveState status={status} />
          </div>
        </form>
      )}
    </div>
  );
}
