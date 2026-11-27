"use client";

import { useTranslations } from "next-intl";

import { useId } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { IconCheck, IconGlobe, IconMic } from "@/components/ui/icons";
import { tileClass, tileOnClass } from "@/components/ui/tile";
import type { CaptureSource, TabAudioSupport } from "@/lib/audio/call";
import { cn } from "@/lib/utils";

/** Input level above this counts as "heard" (same bar as the consent mic check). */
const HEARD = 0.08;

export type CallShareError = "no-audio" | "not-tab" | "stopped" | "failed";

/** "Var hålls mötet?": here in the room (the laptop's mic) or in a video call (the call tab + mic). */
export function SourcePicker({ value, onChange, disabled }: { value: CaptureSource; onChange: (s: CaptureSource) => void; disabled?: boolean }) {
  const t = useTranslations("live.call");
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-semibold">{t("question")}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(["room", "call"] as const).map((s) => (
          <label
            key={s}
            className={cn(
              // Tiles on the card, no frames (docs/ui.md "No double borders"): a tint, darker when chosen.
              "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-colors duration-120",
              value === s ? tileOnClass : tileClass,
            )}
          >
            <input type="radio" name={`${id}-source`} value={s} checked={value === s} onChange={() => onChange(s)} className="size-4 accent-[var(--ink)]" />
            {s === "room" ? <IconMic size={18} className="shrink-0" aria-hidden="true" /> : <IconGlobe size={18} className="shrink-0" aria-hidden="true" />}
            <span>{t(s)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Meter({ label, level }: { label: string; level: number | null }) {
  const t = useTranslations("live.call");
  const bars = level == null ? 0 : Math.min(5, Math.ceil(level * 5));
  const heard = level != null && level >= HEARD;
  return (
    <div className="flex min-h-11 items-center gap-3 text-sm">
      <span className="w-20 font-semibold">{label}</span>
      <span className="inline-flex h-5 items-end gap-[3px]" role="meter" aria-valuemin={0} aria-valuemax={5} aria-valuenow={bars} aria-label={t("levelOf", { who: label })}>
        {["h-[30%]", "h-[45%]", "h-[60%]", "h-[80%]", "h-full"].map((height, i) => (
          <span key={height} className={cn("w-[6px] rounded-[2px]", height, i < bars ? "bg-green" : "bg-line")} />
        ))}
      </span>
      <span className={heard ? "font-semibold text-green" : "text-ink-2"} aria-hidden="true">
        {heard ? t("heard") : t("silent")}
      </span>
    </div>
  );
}

/**
 * A drawing of Chrome's share dialog (not a screenshot: it follows the theme and the language),
 * with the two things to do marked: the meeting's tab, and "Dela flikljud".
 */
function ShareDialogIllustration() {
  const t = useTranslations("live.call");
  return (
    <figure className="flex flex-col gap-2">
      <div aria-hidden="true" className="overflow-hidden rounded-lg bg-surface text-xs shadow-panel select-none">
        <div className="border-b border-line px-3 py-2 font-semibold">{t("dlgTitle")}</div>
        <div className="flex gap-4 border-b border-line px-3 pt-2">
          <span className="border-b-2 border-ink pb-1.5 font-semibold">{t("dlgTab")}</span>
          <span className="pb-1.5 text-ink-3">{t("dlgWindow")}</span>
          <span className="pb-1.5 text-ink-3">{t("dlgScreen")}</span>
        </div>
        <div className="flex flex-col gap-1 p-2">
          <div className="relative flex items-center gap-2 rounded-md bg-green-wash px-2 py-1.5 font-medium ring-2 ring-green">
            <span className="size-3 rounded-sm bg-green" />
            {t("dlgMeet")}
            <span className="absolute -top-2 -right-1 grid size-5 place-items-center rounded-full bg-green text-[11px] font-bold text-on-green">1</span>
          </div>
          <div className="flex items-center gap-2 px-2 py-1.5 text-ink-3">
            <span className="size-3 rounded-sm bg-line" />
            {t("dlgOther")}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
          <span className="relative inline-flex items-center gap-2 rounded-md py-0.5 pr-3 pl-1 font-medium ring-2 ring-green">
            <span className="grid size-3.5 place-items-center rounded-[3px] bg-green text-on-green">
              <IconCheck size={10} />
            </span>
            {t("dlgAudio")}
            <span className="absolute -top-2.5 -right-3 grid size-5 place-items-center rounded-full bg-green text-[11px] font-bold text-on-green">2</span>
          </span>
          <span className="flex gap-1.5">
            <span className="rounded-md border border-line px-2 py-1 text-ink-2">{t("dlgCancel")}</span>
            <span className="rounded-md bg-ink px-2 py-1 text-on-ink">{t("dlgShare")}</span>
          </span>
        </div>
      </div>
      <figcaption className="text-xs text-ink-3">{t("illustration")}</figcaption>
    </figure>
  );
}

/**
 * The video-call path on the start screen: three steps, a drawing of Chrome's share dialog, the
 * "Välj mötesfliken" button (opens the picker from the click), then "Du" and "Samtalet" meters
 * so the user sees both sides are heard. Browsers without tab audio get the reason and a mic-only
 * fallback instead.
 */
export function CallSetup({
  support,
  micOnly,
  onMicOnly,
  shared,
  sharing,
  error,
  levels,
  onShare,
  disabled,
}: {
  support: TabAudioSupport;
  /** The user chose to record with the mic only (no tab audio in this browser). */
  micOnly: boolean;
  onMicOnly: () => void;
  /** A tab with audio is shared. */
  shared: boolean;
  /** The picker is open. */
  sharing: boolean;
  error: CallShareError | null;
  levels: { mic: number; call: number | null } | null;
  onShare: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations("live.call");
  if (support !== "ok") {
    const why = support === "device" ? "device" : "unsupported";
    return micOnly ? (
      <p className="text-sm text-ink-2" role="status">
        {t("micOnlyOn")}
      </p>
    ) : (
      <Banner tone="info" title={t(`errors.${why}.title`)}>
        <span className="flex flex-col items-start gap-3">
          <span>{t(`errors.${why}.text`)}</span>
          <Button size="sm" icon={<IconMic size={18} />} onClick={onMicOnly}>
            {t("micOnly")}
          </Button>
        </span>
      </Banner>
    );
  }
  const bothHeard = levels != null && levels.mic >= HEARD && (levels.call ?? 0) >= HEARD;
  return (
    <div className="flex flex-col gap-4 rounded-lg bg-sunk/60 p-4">
      <ol className="flex flex-col gap-2 text-sm">
        {(["step1", "step2", "step3"] as const).map((k, i) => (
          <li key={k} className="grid grid-cols-[1.5rem_1fr] items-baseline gap-2">
            <span className="grid size-6 place-items-center rounded-full bg-surface text-xs font-semibold">{i + 1}</span>
            <span>{t(k)}</span>
          </li>
        ))}
      </ol>
      {!shared && <ShareDialogIllustration />}
      {error && (
        <Banner tone="warning" title={t(`errors.${error}.title`)}>
          {t(`errors.${error}.text`)}
        </Banner>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={shared ? "secondary" : "primary"} size={shared ? "sm" : "md"} onClick={onShare} loading={sharing} disabled={disabled}>
          {sharing ? t("sharing") : shared ? t("shareAgain") : t("share")}
        </Button>
      </div>
      {shared && (
        <div className="flex flex-col gap-1">
          <Meter label={t("you")} level={levels?.mic ?? 0} />
          <Meter label={t("theCall")} level={levels?.call ?? 0} />
          <p className="text-sm text-ink-2" role="status">
            {bothHeard ? t("bothHeard") : (levels?.call ?? 0) < HEARD ? t("callQuiet") : ""}
          </p>
          <p className="text-xs text-ink-3">{t("headphones")}</p>
        </div>
      )}
    </div>
  );
}
