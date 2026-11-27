"use client";

import { useTranslations } from "next-intl";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconChevronDown, IconMic, IconMicOff } from "@/components/ui/icons";
import type { CaptureSource } from "@/lib/audio/call";
import { cn } from "@/lib/utils";
import { SourcePicker } from "./CallSetup";

export type StartError = "mic-denied" | "mic-missing" | "start-failed" | "limit" | "call-no-audio" | "call-not-tab" | "call-failed" | null;


/** The banner for a start error; `text` replaces the default explanation (e.g. the server's own message). */
export function StartErrorBanner({
  error,
  text,
  action,
}: {
  error: Exclude<StartError, null>;
  text?: string | null;
  action?: ReactNode;
}) {
  const t = useTranslations("live.consent.errors");
  const problem = { title: t(`${error}.title`), text: t(`${error}.text`) };
  return (
    <Banner tone="danger" icon={error.startsWith("mic") ? <IconMicOff /> : undefined} title={problem.title} action={action}>
      {text ?? problem.text}
    </Banner>
  );
}

/** Input level above this counts as "we hear you". */
const HEARD = 0.08;

/** No sound this long after the check started: a quiet note (never blocks Start). */
const SILENT_MS = 8000;

/**
 * Before Start, on one screen (ten people are waiting): the förening and the meeting it will be
 * (`agenda`: the AgendaStep's one line with "Byt", or Privat's ContextPicker), one consent
 * checkbox (logged per meeting), the big Start. Ticking the box is a click, so it also starts the
 * mic check (capture.ts: the mic must be opened from a gesture); only a problem is shown. The rest
 * (mic level, how it works) is folded under "Inställningar för mötet". Start also waits for
 * `agendaConfirmed`.
 */
export function ConsentStep({
  orgName,
  shareTranscript,
  onStart,
  starting,
  error,
  errorText,
  micLevel,
  onMicCheck,
  onMicCheckStop,
  agenda,
  agendaConfirmed = true,
  agendaDoc = null,
  onNewDocInstead,
  eventTitle,
  privat = false,
  settingsOpen,
  source,
  onSourceChange,
  foretag = false,
  callSetup,
  callReady = true,
  callHint,
}: {
  orgName: string;
  /** Started from a calendar event (todo #14): its title, as read on the server (Privat only; the AgendaStep line shows it otherwise). */
  eventTitle?: string | null;
  /** Whether the transcript gets its own tab in the Doc (org setting). */
  shareTranscript: boolean;
  onStart: () => void;
  starting?: boolean;
  error?: StartError;
  /** Replaces the error's default explanation (e.g. the server's Swedish message). */
  errorText?: string | null;
  /** Mic input level 0–1 while the check runs; null/undefined before it has started. */
  micLevel?: number | null;
  /** Ask for the mic and start reporting `micLevel` (on the consent tick, or "Testa mikrofonen"). Without it, no mic check. */
  onMicCheck?: () => void;
  /** The consent was unticked: let go of the mic again. */
  onMicCheckStop?: () => void;
  /** The meeting it will be: the AgendaStep (one line + "Byt"), or Privat's ContextPicker. */
  agenda?: ReactNode;
  /** The agenda choice is confirmed (Använd, a Picker pick, or "Skapa nytt dokument"). */
  agendaConfirmed?: boolean;
  /** The meeting runs in the förening's own agenda Doc (the facts say so). */
  agendaDoc?: { transcriptInDoc: boolean } | null;
  /** After an agenda_* start error: "Skapa nytt dokument i stället" in the error banner. */
  onNewDocInstead?: () => void;
  /** A Privat recording (0045): the facts and hints speak of the user's own notes, not a förening's Doc. */
  privat?: boolean;
  /** /design: render "Inställningar för mötet" (and "Så fungerar det" in it) open. */
  settingsOpen?: boolean;
  /** "Var hålls mötet?" (absent: no choice, the room as before). */
  source?: CaptureSource;
  onSourceChange?: (s: CaptureSource) => void;
  /** A Företag: a video call is consented to as the user's own recording (like Privat). */
  foretag?: boolean;
  /** The video-call steps (CallSetup), shown under the choice when `source` is "call". */
  callSetup?: ReactNode;
  /** Video call: the meeting tab is shared (or the mic-only fallback was chosen). */
  callReady?: boolean;
  /** Why Start waits on the video call (default: share the tab first). */
  callHint?: string;
}) {
  const t = useTranslations("live.consent");
  const tCal = useTranslations("calendar");
  const tp = useTranslations("privat.live");
  const tc = useTranslations("live.call");
  const [confirmed, setConfirmed] = useState(false);
  const id = useId();
  const testing = micLevel != null;
  const heard = testing && micLevel >= HEARD;
  const bars = testing ? Math.min(5, Math.ceil(micLevel * 5)) : 0;
  // Screen readers hear the check's result once, not every flip of the meter (D).
  const [everHeard, setEverHeard] = useState(false);
  useEffect(() => {
    if (heard) setEverHeard(true);
  }, [heard]);
  // Nothing heard a while after the check started: say so quietly, outside the fold.
  const [silent, setSilent] = useState(false);
  useEffect(() => {
    if (!testing || everHeard) {
      setSilent(false);
      return;
    }
    const timer = setTimeout(() => setSilent(true), SILENT_MS);
    return () => clearTimeout(timer);
  }, [testing, everHeard]);

  const call = source === "call";
  const ready = confirmed && agendaConfirmed && (!call || callReady);
  // Video call: a Förening still confirms that everyone knows; Företag and Privat record a call the
  // user takes part in, on their own responsibility (no announcement required).
  const consentText = !call ? t("everyone") : privat || foretag ? tc("ownCall") : tc("everyoneCall");
  const changeSource = (s: CaptureSource) => {
    if (s === source) return;
    // Another statement to confirm: the tick starts over, and the room's mic check stops.
    setConfirmed(false);
    if (testing) onMicCheckStop?.();
    onSourceChange?.(s);
  };

  const onConsent = (on: boolean) => {
    setConfirmed(on);
    // The tick is a click: open the mic from it, so Start finds it ready (and a problem shows now).
    if (on && !testing) onMicCheck?.();
    if (!on && testing) onMicCheckStop?.();
  };

  return (
    <section className="flex flex-col gap-5 rounded-lg bg-surface p-[clamp(1.25rem,4vw,2.5rem)] shadow-panel" aria-labelledby={`${id}-title`}>
      <div className="flex flex-col gap-1">
        <p className="text-ink-2">{orgName}</p>
        <h1 id={`${id}-title`} className="text-2xl">
          {privat ? tp("consentTitle") : t("title")}
        </h1>
        {privat && eventTitle && <p className="text-sm text-ink-2">{tCal("fromCalendar", { title: eventTitle })}</p>}
      </div>

      {agenda}
      {privat && <p className="-mt-2 text-sm text-ink-2">{tp("consentFact")}</p>}

      {onSourceChange && source && <SourcePicker value={source} onChange={changeSource} disabled={starting} />}
      {call && callSetup}

      {error && (
        <StartErrorBanner
          error={error}
          text={errorText}
          action={
            onNewDocInstead ? (
              <Button size="sm" onClick={onNewDocInstead}>
                {t("newDocInstead")}
              </Button>
            ) : undefined
          }
        />
      )}
      {silent && !error && (
        <p className="flex items-center gap-2 text-sm text-ink-2" role="status">
          <IconMicOff size={16} aria-hidden="true" />
          {privat ? tp("silent") : t("silent")}
        </p>
      )}

      <label
        className={cn(
          "grid cursor-pointer grid-cols-[auto_1fr] items-center gap-3 rounded-lg border border-control p-4 leading-[1.35] font-medium transition-colors duration-120 hover:border-ink-3",
          confirmed && "border-green bg-green-wash hover:border-green",
        )}
        htmlFor={`${id}-ok`}
      >
        <Checkbox id={`${id}-ok`} tone="green" checked={confirmed} onCheckedChange={(on) => onConsent(on === true)} disabled={starting} />
        <span className="flex flex-col gap-1">
          <span>{consentText}</span>
          {call && (privat || foretag) && <span className="text-sm font-normal text-ink-2">{tc("ownCallHint")}</span>}
        </span>
      </label>

      <Button
        variant="primary"
        size="lg"
        block
        icon={<IconMic />}
        disabled={!ready}
        loading={starting}
        onClick={onStart}
        aria-describedby={!ready ? `${id}-why` : undefined}
      >
        {starting ? t("starting") : privat ? tp("start") : t("start")}
      </Button>
      {!ready && (
        <p id={`${id}-why`} className="-mt-3 text-center text-xs text-ink-3">
          {call && !callReady ? (callHint ?? tc("shareFirst")) : !confirmed ? t("tickFirst") : privat ? tp("contextFirst") : t("agendaFirst")}
        </p>
      )}

      {/* Outside the fold: a closed <details> hides its content from screen readers too. */}
      <span className="sr-only" aria-live="polite">
        {testing ? (everHeard ? t("works") : t("testing")) : ""}
      </span>

      <details className="group/settings border-t border-line pt-3" open={settingsOpen}>
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-sm font-semibold text-ink-2 select-none hover:text-ink [&::-webkit-details-marker]:hidden">
          <IconChevronDown size={16} className="-rotate-90 transition-transform duration-120 group-open/settings:rotate-0" aria-hidden="true" />
          {privat ? tp("settings") : t("settings")}
        </summary>
        <div className="mt-2 flex flex-col gap-4 pl-6">
          {(onMicCheck || testing) && (
            <div className="flex min-h-11 flex-wrap items-center gap-3 text-sm">
              <span className="font-semibold">{t("mic")}</span>
              {testing ? (
                <>
                  <span className="inline-flex h-5 items-end gap-[3px]" role="meter" aria-valuemin={0} aria-valuemax={5} aria-valuenow={bars} aria-label={t("level")}>
                    {["h-[30%]", "h-[45%]", "h-[60%]", "h-[80%]", "h-full"].map((height, i) => (
                      <span key={height} className={cn("w-[6px] rounded-[2px]", height, i < bars ? "bg-green" : "bg-line")} />
                    ))}
                  </span>
                  <span className={heard ? "font-semibold text-green" : "text-ink-2"} aria-hidden="true">
                    {heard ? t("hear") : t("hearNothing")}
                  </span>
                </>
              ) : (
                <Button size="sm" icon={<IconMic size={18} />} onClick={onMicCheck}>
                  {t("test")}
                </Button>
              )}
            </div>
          )}
          <details className="group/how" open={settingsOpen}>
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-sm font-semibold text-ink-2 select-none hover:text-ink [&::-webkit-details-marker]:hidden">
              <IconChevronDown size={16} className="-rotate-90 transition-transform duration-120 group-open/how:rotate-0" aria-hidden="true" />
              {t("howItWorks")}
            </summary>
            <ul className="mt-1 flex list-dash flex-col gap-2 pl-[1.1rem] text-sm text-ink-2 marker:text-ink-3">
              <li>{t("laptop")}</li>
              {privat ? null : agendaDoc ? (
                <li>
                  {t("agendaDoc")}
                  {agendaDoc.transcriptInDoc ? t("agendaWithTranscript") : t("agendaNoTranscript")}
                </li>
              ) : (
                <li>
                  {t("newDoc")}
                  {shareTranscript ? t("newWithTranscript") : t("newNoTranscript")}
                </li>
              )}
              <li>{t("pause")}</li>
              <li>{t("lid")}</li>
            </ul>
          </details>
        </div>
      </details>
    </section>
  );
}
