"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { IconCheck } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import { mailSummary } from "@/lib/account/summary";
import { useSectionSummary } from "./AccountSection";
import {
  EMAIL_CATEGORIES,
  type EmailCategory,
  type EmailPrefs,
  withCategory,
} from "@/lib/email/categories";

export type SaveEmailPrefs = (prefs: EmailPrefs) => Promise<boolean>;

/** Inför möten for föreningar (0059): an opt-in under the meeting_brief switch (Konto only). */
export interface BriefForeningarPref {
  initial: boolean;
  save: (on: boolean) => Promise<boolean>;
}

/**
 * One switch per kind of mail, and under them "Stäng av alla mejl". Each change saves at once (no
 * Save button) and says "Sparat"; a failed save puts the switch back and says so. "Stäng av alla
 * mejl" greys the categories out but keeps their values, so turning mail back on restores them.
 * Used by Konto (signed in) and /mejl (the signed link in a mail).
 */
export function EmailPrefsForm({
  initial,
  save,
  idPrefix = "mail",
  highlight,
  briefForeningar,
}: {
  initial: EmailPrefs;
  save: SaveEmailPrefs;
  idPrefix?: string;
  briefForeningar?: BriefForeningarPref;
  /** The category the mail's link was about: named first, so it's the obvious one to turn off. */
  highlight?: EmailCategory;
}) {
  const t = useTranslations("mailPrefs");
  const [prefs, setPrefs] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saved" | "failed">("idle");
  const [pending, startTransition] = useTransition();
  // Each change gets a number; a failed save only puts things back if nothing newer was chosen.
  const latest = useRef(0);

  useEffect(() => {
    if (status !== "saved") return;
    const timer = setTimeout(() => setStatus("idle"), 3000);
    return () => clearTimeout(timer);
  }, [status]);

  const apply = (next: EmailPrefs) => {
    const before = prefs;
    const id = ++latest.current;
    setPrefs(next);
    setStatus("idle");
    startTransition(async () => {
      const ok = await save(next).catch(() => false);
      if (id !== latest.current) return;
      if (ok) setStatus("saved");
      else {
        setPrefs(before);
        setStatus("failed");
      }
    });
  };

  const [orgBriefs, setOrgBriefs] = useState(briefForeningar?.initial ?? false);
  const applyOrgBriefs = (on: boolean) => {
    if (!briefForeningar) return;
    const id = ++latest.current;
    setOrgBriefs(on);
    setStatus("idle");
    startTransition(async () => {
      const ok = await briefForeningar.save(on).catch(() => false);
      if (id !== latest.current) return;
      if (ok) setStatus("saved");
      else {
        setOrgBriefs(!on);
        setStatus("failed");
      }
    });
  };

  // Konto: the section header's "5 av 6 på" follows the switches.
  const account = useTranslations("account");
  const count = mailSummary(prefs, briefForeningar ? orgBriefs : undefined);
  useSectionSummary(count.on === 0 ? account("summaryMailAllOff") : account("summaryMailOn", { on: count.on, total: count.total }), count.on > 0);

  const order = highlight ? [highlight, ...EMAIL_CATEGORIES.filter((c) => c !== highlight)] : [...EMAIL_CATEGORIES];

  return (
    <div className="flex flex-col gap-4" aria-busy={pending}>
      <ul className="flex flex-col divide-y divide-line">
        {order.map((category) => {
          const id = `${idPrefix}-${category}`;
          return (
            <li key={category} className="py-3 first:pt-0 last:pb-0">
              <SwitchRow
                id={id}
                title={t(`categories.${category}.label`)}
                checked={!prefs.off.includes(category)}
                disabled={prefs.allOff}
                onChange={(on) => apply(withCategory(prefs, category, on))}
              >
                {t(`categories.${category}.description`)}
              </SwitchRow>
              {category === "meeting_brief" && briefForeningar && (
                <div className="mt-3 border-l-2 border-line pl-4">
                  <SwitchRow
                    id={`${idPrefix}-brief-foreningar`}
                    title={t("briefForeningar.label")}
                    checked={orgBriefs && !prefs.off.includes("meeting_brief")}
                    disabled={prefs.allOff || prefs.off.includes("meeting_brief")}
                    onChange={applyOrgBriefs}
                  >
                    {t("briefForeningar.description")}
                  </SwitchRow>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col items-start gap-1 border-t border-line pt-3">
        {prefs.allOff && <p className="text-sm text-ink-2">{t("allOffOn")}</p>}
        <Button variant="ghost" size="sm" className="-mx-2" onClick={() => apply({ allOff: !prefs.allOff, off: prefs.off })}>
          {prefs.allOff ? t("allOn") : t("allOff")}
        </Button>
      </div>
      <p className="min-h-6 text-sm" role="status" aria-live="polite">
        {status === "saved" && (
          <span className="inline-flex items-center gap-1 font-semibold text-green">
            <IconCheck size={18} /> {t("saved")}
          </span>
        )}
        {status === "failed" && <span className="font-semibold text-red">{t("saveFailed")}</span>}
      </p>
    </div>
  );
}

function SwitchRow({
  id,
  title,
  checked,
  disabled,
  onChange,
  children,
}: {
  id: string;
  title: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  const bodyId = `${id}-body`;
  return (
    // The whole row is the target (≥ 44px on phones), not just the 24px switch.
    <label
      htmlFor={id}
      className="grid min-h-11 cursor-pointer grid-cols-[1fr_auto] items-start gap-x-4 gap-y-1 has-[:disabled]:cursor-not-allowed"
    >
      <span className="font-medium">{title}</span>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-describedby={bodyId}
        className="row-span-2 mt-0.5"
      />
      <span id={bodyId} className="text-sm text-ink-2">
        {children}
      </span>
    </label>
  );
}
