"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Check } from "@/components/ui/Field";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

export interface ForetagChoice {
  groupId: string | null;
  private: boolean;
  /** The calendar event the starter confirmed, or null. */
  calendarEventId: string | null;
  /** Colleagues the starter ticked as attending (only with a confirmed event). */
  attendeeIds: string[];
}

/** The event happening now in the starter's own calendar, as offered (never attached by itself). */
export interface ForetagEventOffer {
  id: string;
  title: string;
  /** Colleagues (company members) on its guest list; accepted ones are pre-ticked, declined ones can't be ticked. */
  colleagues: { userId: string; name: string; accepted: boolean; declined?: boolean }[];
  /** The outside guests' domain: the customer, if the event is confirmed (and not a Privat möte). */
  customerDomain: string | null;
}

const WHOLE = "__whole";

/**
 * Before a Företag meeting (the live page's consent step, where a förening picks its agenda):
 * who the meeting is for, whether it is a Privat möte, and, when the calendar has an event now,
 * whether to connect it ("Koppla till kalenderhändelsen?", off by default) and which colleagues on
 * it attend. Attending gives access, so every attendee is the starter's explicit tick. One line
 * says who will see the meeting. The default group is the starter's own (the safe side).
 */
export function GroupPicker({
  groups,
  initialGroupId,
  event,
  onChange,
  disabled,
  space = "foretag",
}: {
  /** The wording: a Företag ("Hela företaget") or a förening with groups (0054, "Hela föreningen"). */
  space?: "foretag" | "forening";
  /** Active groups in tree order, with their depth. */
  groups: { id: string; name: string; depth: number }[];
  initialGroupId: string | null;
  event: ForetagEventOffer | null;
  onChange: (choice: ForetagChoice) => void;
  disabled?: boolean;
}) {
  const tc = useTranslations("foretag.picker");
  // A förening's own words where they differ (no colleagues to tick: its Privat möte is the starter's and the admins').
  const tf = useTranslations("foretag.picker.forening");
  const t = (key: string, values?: Record<string, string | number>) =>
    space === "forening" && ["whole", "privateHint", "seesWhole", "seesPrivate"].includes(key) ? tf(key as "whole", values) : tc(key as "whole", values);
  const id = useId();
  const [group, setGroup] = useState<string>(initialGroupId && groups.some((g) => g.id === initialGroupId) ? initialGroupId : WHOLE);
  const [priv, setPriv] = useState(false);
  const [linked, setLinked] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set((event?.colleagues ?? []).filter((c) => c.accepted && !c.declined).map((c) => c.userId)));

  useEffect(() => {
    onChange({
      groupId: group === WHOLE ? null : group,
      private: priv,
      calendarEventId: linked && event ? event.id : null,
      attendeeIds: linked && event ? [...ticked] : [],
    });
  }, [group, priv, linked, ticked, event, onChange]);

  const name = groups.find((g) => g.id === group)?.name;
  const sees = priv ? t("seesPrivate") : group === WHOLE ? t("seesWhole") : t("seesGroup", { group: name ?? "" });
  const toggle = (userId: string, on: boolean) =>
    setTicked((s) => {
      const next = new Set(s);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-group`}>{t("label")}</Label>
        <NativeSelect id={`${id}-group`} value={group} onChange={(e) => setGroup(e.target.value)} disabled={disabled}>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {`${" ".repeat(g.depth)}${g.name}`}
            </option>
          ))}
          <option value={WHOLE}>{t("whole")}</option>
        </NativeSelect>
      </div>
      <Check id={`${id}-private`} title={t("private")} checked={priv} onCheckedChange={(on) => setPriv(on === true)} disabled={disabled}>
        {t("privateHint")}
      </Check>
      {event && (
        <div className="flex flex-col gap-3 rounded-md bg-sunk/60 p-4">
          <Check id={`${id}-event`} title={t("eventLink", { title: event.title })} checked={linked} onCheckedChange={(on) => setLinked(on === true)} disabled={disabled}>
            {t("eventHint")}
          </Check>
          {linked && (
            <fieldset className="flex flex-col gap-2 pl-7">
              <legend className="mb-1 text-sm font-medium">{t("attendeesLabel")}</legend>
              {event.colleagues.length === 0 ? (
                <p className="text-sm text-ink-3">{t("noColleagues")}</p>
              ) : (
                event.colleagues.map((c) => (
                  <Check
                    key={c.userId}
                    id={`${id}-a-${c.userId}`}
                    title={c.name}
                    checked={!c.declined && ticked.has(c.userId)}
                    onCheckedChange={(on) => toggle(c.userId, on === true)}
                    disabled={disabled || c.declined}
                  >
                    {c.declined ? t("declined") : c.accepted ? t("accepted") : t("notAccepted")}
                  </Check>
                ))
              )}
              {event.customerDomain && !priv && <p className="text-sm text-ink-2">{t("customer", { domain: event.customerDomain })}</p>}
            </fieldset>
          )}
        </div>
      )}
      <p className="text-sm text-ink-2" aria-live="polite">
        {sees}
        {linked && ticked.size > 0 && ` ${t("seesAttendees", { count: ticked.size })}`}
      </p>
    </div>
  );
}
