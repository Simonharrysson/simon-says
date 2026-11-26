"use client";

import { useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { SubmitButton } from "@/components/ui/SubmitButton";

/** The `?kalender=` result the consent (or "Koppla från") returns with. */
export type CalendarResult = "ok" | "nej" | "fel" | "konto" | "fran";

export function calendarResult(raw: string | undefined): CalendarResult | undefined {
  return raw === "ok" || raw === "nej" || raw === "fel" || raw === "konto" || raw === "fran" ? raw : undefined;
}

/** The result line after "Koppla kalender" / "Koppla från". */
export function CalendarResultBanner({ result }: { result?: CalendarResult }) {
  const t = useTranslations("calendar");
  if (!result) return null;
  const tone = result === "ok" || result === "fran" ? "success" : result === "fel" ? "danger" : "warning";
  return <Banner tone={tone}>{t(`result.${result}`)}</Banner>;
}

/** "Koppla kalender": one button, the consent at Google; `back` is where it returns. */
export function ConnectCalendarButton({ action, back, variant = "secondary" }: { action: FormAction; back: string; variant?: "primary" | "secondary" | "ghost" }) {
  const t = useTranslations("calendar");
  return (
    <form action={action}>
      <input type="hidden" name="back" value={back} />
      <SubmitButton variant={variant}>{t("connect")}</SubmitButton>
    </form>
  );
}

/**
 * Inställningar → "Kalender" (todo #14): connect the user's Google Calendar (read only), or
 * "Koppla från" (deletes our copy; confirmed, like every delete).
 */
export function CalendarConnect({
  connected,
  connect,
  disconnect,
  back,
  result,
}: {
  connected: boolean;
  connect: FormAction;
  disconnect: FormAction;
  back: string;
  result?: CalendarResult;
}) {
  const t = useTranslations("calendar");
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-2 max-w-[68ch]">{t("connectIntro")}</p>
      <CalendarResultBanner result={result} />
      {connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p>{t("connected")}</p>
          <ConfirmAction
            action={disconnect}
            hidden={{ back }}
            trigger={t("disconnect")}
            triggerVariant="secondary"
            title={t("disconnectTitle")}
            description={t("disconnectText")}
            confirmLabel={t("disconnect")}
            pendingLabel={t("disconnecting")}
          />
        </div>
      ) : (
        <div>
          <ConnectCalendarButton action={connect} back={back} />
        </div>
      )}
    </div>
  );
}
