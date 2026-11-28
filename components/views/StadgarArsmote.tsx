"use client";

import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";
import { PickerError, usePicker } from "@/components/google/Picker";
import { Banner } from "@/components/ui/Banner";
import { Button, Spinner } from "@/components/ui/button";
import { hintClass } from "@/components/ui/Field";
import { IconCheck, IconPlus, IconTrash } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The stadgar → the årsmöte's agenda (todo #15), shared by onboarding step 4 and Mötesformat's
// "Lägg in årsmötet från stadgarna": pick the stadgar (Doc or PDF), Simon Says reads them (one
// Claude call), the admin checks the list, and it is saved as the förening's own Årsmöte format.
// The stadgar feed only the årsmöte: no items are added to board or weekly meetings.

// Copy: stadgar.* in lib/i18n/messages.

const ARSMOTE_MAX = 18;

export type StadgarPhase =
  | { phase: "idle" }
  | { phase: "reading" }
  | { phase: "review"; arsmote: string[] }
  | { phase: "saving"; arsmote: string[] }
  | { phase: "saved"; arsmote: number }
  | { phase: "error"; message: string };

/** The flow's state and actions. `pick` calls the Picker right away, so the click's activation reaches it. */
export function useStadgarArsmote(orgId: string, onSaved?: () => void) {
  const t = useTranslations("stadgar");
  const picker = usePicker({ orgId });
  const [stadgar, setStadgar] = useState<StadgarPhase>({ phase: "idle" });

  const pick = async () => {
    let picked;
    try {
      picked = await picker.open({ mode: "doc-or-pdf", title: t("pickTitle") });
    } catch (err) {
      setStadgar({ phase: "error", message: err instanceof PickerError ? err.message : t("pickerFailed") });
      return;
    }
    if (!picked?.[0]) return;
    setStadgar({ phase: "reading" });
    try {
      const res = await fetch(`/api/orgs/${orgId}/onboarding/stadgar`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId: picked[0].id }),
      });
      const json = (await res.json().catch(() => null)) as { arsmote?: string[]; message?: string } | null;
      if (!res.ok || !Array.isArray(json?.arsmote)) {
        setStadgar({ phase: "error", message: json?.message ?? t("readFailed") });
        return;
      }
      setStadgar({ phase: "review", arsmote: json.arsmote });
    } catch {
      setStadgar({ phase: "error", message: t("offline") });
    }
  };

  const save = async () => {
    if (stadgar.phase !== "review") return;
    const { arsmote } = stadgar;
    setStadgar({ phase: "saving", arsmote });
    const res = await fetch(`/api/orgs/${orgId}/onboarding/formats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arsmote }),
    }).catch(() => null);
    if (res?.ok) {
      setStadgar({ phase: "saved", arsmote: arsmote.length });
      onSaved?.();
    } else {
      const json = (await res?.json().catch(() => null)) as { message?: string } | null;
      setStadgar({ phase: "error", message: json?.message ?? t("saveFailed") });
    }
  };

  return {
    stadgar,
    pick,
    save,
    change: (arsmote: string[]) => stadgar.phase === "review" && setStadgar({ phase: "review", arsmote }),
    cancel: () => setStadgar({ phase: "idle" }),
  };
}

export interface StadgarArsmoteProps {
  uid: string;
  stadgar: StadgarPhase;
  pickerEnabled: boolean;
  /** An årsmöte from the stadgar is already saved (an earlier visit). */
  saved?: boolean;
  onPick: () => void;
  onChange: (arsmote: string[]) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** Presentational: the flow in each phase (used by onboarding, Mötesformat and /design). */
export function StadgarArsmote(p: StadgarArsmoteProps) {
  const t = useTranslations("stadgar");
  const common = useTranslations("common");
  const s = p.stadgar;
  if (s.phase === "reading") {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-2" role="status" aria-live="polite">
        <Spinner /> {t("reading")}
      </p>
    );
  }
  if (s.phase === "review" || s.phase === "saving") {
    return (
      <div className="mt-2 flex flex-col gap-6 animate-notice-in">
        <ItemList
          uid={`${p.uid}-ars`}
          title={t("agendaTitle")}
          empty={t("empty")}
          items={s.arsmote}
          max={ARSMOTE_MAX}
          onChange={p.onChange}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={p.onSave} loading={s.phase === "saving"}>
            {t("save")}
          </Button>
          <Button variant="ghost" onClick={p.onCancel} disabled={s.phase === "saving"}>
            {common("cancel")}
          </Button>
        </div>
      </div>
    );
  }
  if (s.phase === "saved" || (s.phase === "idle" && p.saved)) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="flex items-start gap-2 text-sm text-green" aria-live="polite">
          <IconCheck size={18} className="mt-[0.1rem] flex-none" />
          <span>
            {s.phase === "saved"
              ? s.arsmote
                ? t("saved", { count: s.arsmote })
                : t("standard")
              : t("follows")}
          </span>
        </p>
        {p.pickerEnabled && (
          <Button variant="ghost" size="sm" onClick={p.onPick}>
            {t("readAgain")}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-3">
      {s.phase === "error" && (
        <Banner tone="danger" live={false}>
          {s.message}
        </Banner>
      )}
      {p.pickerEnabled ? (
        <Button variant="secondary" onClick={p.onPick}>
          {s.phase === "error" ? t("tryAgain") : t("pick")}
        </Button>
      ) : (
        <p className="text-sm text-ink-3">{t("pickerOff")}</p>
      )}
      <p className={hintClass}>{t("hint")}</p>
    </div>
  );
}

function ItemList({ uid, title, empty, items, max, onChange }: { uid: string; title: string; empty: string; items: string[]; max: number; onChange: (items: string[]) => void }) {
  const t = useTranslations("stadgar");
  const [draft, setDraft] = useState("");
  const add = (e: FormEvent) => {
    e.preventDefault();
    const clean = draft.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!clean || items.length >= max) return;
    onChange([...items, clean]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">
        {title} <span className="font-normal text-ink-3">· {t("items", { count: items.length })}</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-ink-3">{empty}</p>
      ) : (
        <ol className="flex flex-col rounded-lg bg-surface shadow-panel in-card:-mx-6 in-card:bg-transparent in-card:shadow-none">
          {items.map((item, i) => (
            <li key={`${i}-${item}`} className="flex min-h-11 items-center gap-3 border-t border-line px-4 py-1 first:border-t-0 in-card:px-6">
              <span className="w-6 flex-none font-mono text-xs text-ink-3">{i + 1}.</span>
              <span className="min-w-0 flex-1 text-sm wrap-anywhere">{item}</span>
              <Button variant="danger-ghost" size="sm" iconOnly icon={<IconTrash size={16} />} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                {t("removeItem", { item })}
              </Button>
            </li>
          ))}
        </ol>
      )}
      {items.length < max && (
        <form onSubmit={add} className="flex gap-2">
          <Label htmlFor={`${uid}-add`} className="sr-only">
            {t("newItem", { title })}
          </Label>
          <Input id={`${uid}-add`} value={draft} maxLength={80} placeholder={t("addPlaceholder")} onChange={(e) => setDraft(e.target.value)} />
          <Button type="submit" variant="ghost" icon={<IconPlus size={18} />} disabled={!draft.trim()}>
            {t("add")}
          </Button>
        </form>
      )}
    </div>
  );
}
