"use client";

import { useLocale, useTranslations } from "next-intl";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { IconPlay, IconStop } from "@/components/ui/icons";
import { formatClock } from "@/lib/format";
import { StartErrorBanner, type StartError } from "./ConsentStep";
import { LiveDialog, type LiveDialogHandle } from "./LiveDialog";

/**
 * Shown when the page finds an unfinished meeting (live, or abandoned < 2 h ago). When another
 * tab records it right now (`connectedElsewhere`), continuing here takes it over from that tab.
 */
export function ResumeMeeting({
  startedAt,
  orgName,
  onResume,
  connectedElsewhere,
  live = true,
  onEnd,
  resuming,
  error,
  errorText,
  callHint,
}: {
  startedAt: string;
  orgName: string;
  onResume: () => void;
  connectedElsewhere?: boolean;
  /** Still live on the server (not an abandoned one): it ends by itself if nobody continues. */
  live?: boolean;
  onEnd?: () => void;
  resuming?: boolean;
  /** Why "Fortsätt mötet" did not get going (mic blocked, server refused). */
  error?: StartError;
  errorText?: string | null;
  /** The meeting is a video call: Fortsätt opens the share picker again (say so first). */
  callHint?: boolean;
}) {
  const t = useTranslations("live");
  const locale = useLocale();
  const dialog = useRef<LiveDialogHandle>(null);
  return (
    <section data-card className="flex flex-col gap-6 rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel" aria-labelledby="resume-title">
      <div className="flex flex-col gap-2">
        <h1 id="resume-title" className="text-2xl">
          {connectedElsewhere ? t("resume.elsewhereTitle") : t("resume.notEndedTitle")}
        </h1>
        {connectedElsewhere ? (
          <p className="text-ink-2">{t("resume.elsewhereText", { org: orgName, time: formatClock(startedAt, locale) })}</p>
        ) : (
          <p className="text-ink-2">
            {t("resume.notEndedText", { org: orgName, time: formatClock(startedAt, locale) })}
            {live && t("resume.autoEnd")}
          </p>
        )}
      </div>
      {callHint && <p className="text-sm text-ink-2">{t("call.resumeHint")}</p>}
      {error && <StartErrorBanner error={error} text={errorText} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" icon={<IconPlay size={18} />} onClick={onResume} loading={resuming}>
          {connectedElsewhere ? t("resume.takeOver") : t("resume.resume")}
        </Button>
        {onEnd && (
          <Button variant="ghost" size="lg" onClick={() => dialog.current?.showModal()} disabled={resuming}>
            {t("resume.end")}
          </Button>
        )}
      </div>
      {onEnd && (
        <LiveDialog
          ref={dialog}
          id="resume-stop"
          title={t("controls.endTitle")}
          stayLabel={t("controls.cancel")}
          confirmLabel={t("controls.confirmEnd")}
          confirmIcon={<IconStop size={16} />}
          onConfirm={onEnd}
        >
          {t("stopCopy")}
        </LiveDialog>
      )}
    </section>
  );
}
