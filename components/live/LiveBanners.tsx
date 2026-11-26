import { useLocale, useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { IconChevronDown, IconClock, IconDoc, IconRefresh, IconWifiOff } from "@/components/ui/icons";
import { limitWarningText } from "@/lib/ui/limit-copy";
import type { LiveBannerKind } from "@/lib/ui/live-status";
import type { ConnectionState } from "./types";

export interface LiveBannersProps {
  /** From `liveStatus()`: most urgent first. Only the first is shown in full. */
  banners: LiveBannerKind[];
  connection: ConnectionState;
  /** Minutes left before a cap stops the meeting, from 15 min before. */
  minutesLeft?: number | null;
  /** While reconnecting: seconds until the next attempt (shown when ≥ 5 s, R2). */
  retryInSeconds?: number | null;
  /** The cap behind `minutesLeft` (heartbeat `reason`): meeting_length, org_month, global_day… */
  limitReason?: string | null;
  /** Why the stream stopped (state 'error'): token, mic…, refused. */
  streamError?: string | null;
  /** The token route's refusal code, if any (e.g. mint_cap). */
  refusal?: string | null;
  onReLogin?: () => void;
  onRetry?: () => void;
}

/**
 * Every red banner (user must act), most urgent first; a self-fixing one is shown alone or
 * waits behind "Visa 1 varning till". Red only when the user must act (stopped, Doc paused,
 * time running out); things that fix themselves are ink.
 */
export function LiveBanners({
  banners,
  connection,
  minutesLeft,
  limitReason,
  retryInSeconds,
  streamError,
  refusal,
  onReLogin,
  onRetry,
}: LiveBannersProps) {
  const t = useTranslations("live.banners");
  const locale = useLocale();
  if (banners.length === 0) return null;
  const connected = connection === "ok";

  const render = (kind: LiveBannerKind) => {
    switch (kind) {
      case "error": {
        // Retrying can't help once the meeting has used all its sessions (mint_cap).
        const final = refusal === "mint_cap";
        const text = final
          ? t("mintCap")
          : streamError === "token"
            ? t("token")
            : streamError?.startsWith("mic")
              ? t("mic")
              : t("silent");
        return (
          <Banner
            key="error"
            tone="danger"
            loud
            title={final ? t("newMeeting") : t("stopped")}
            action={
              onRetry &&
              !final && (
                <Button variant="primary" icon={<IconRefresh size={18} />} onClick={onRetry}>
                  {t("tryAgain")}
                </Button>
              )
            }
          >
            {text}
          </Banner>
        );
      }
      case "doc":
        return (
          <Banner
            key="doc"
            tone="danger"
            icon={<IconDoc />}
            title={t("docTitle")}
            action={
              onReLogin && (
                <Button variant="primary" onClick={onReLogin}>
                  {t("reLogin")}
                </Button>
              )
            }
          >
            {connected ? t("docConnected") : t("docOffline")}
          </Banner>
        );
      case "time":
        return (
          <Banner key="time" tone="danger" icon={<IconClock />} title={t("timeTitle", { minutes: minutesLeft ?? 0 })}>
            {limitWarningText(limitReason, locale)}
          </Banner>
        );
      case "connection":
        return (
          <Banner
            key="conn"
            tone="warning"
            icon={<IconWifiOff />}
            title={retryInSeconds != null && retryInSeconds >= 5 ? t("reconnectIn", { seconds: retryInSeconds }) : t("audioWaiting")}
          >
            {connection === "offline" ? t("offline") : t("broken")}
          </Banner>
        );
    }
  };

  // Red banners (the user must act) are always shown. Self-fixing ones wait behind a
  // disclosure when something red is already on screen.
  const red = banners.filter((b) => b !== "connection");
  const shown = red.length > 0 ? red : banners.slice(0, 1);
  const rest = banners.filter((b) => !shown.includes(b));
  return (
    <div className="flex flex-col gap-2">
      {shown.map(render)}
      {rest.length > 0 && (
        <details className="group/more">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-3 text-sm font-semibold text-ink transition-colors duration-120 hover:bg-sunk [&::-webkit-details-marker]:hidden">
            {t("more", { count: rest.length })}
            <IconChevronDown size={16} className="transition-transform duration-120 ease-out group-open/more:rotate-180" />
          </summary>
          <div className="flex flex-col gap-2">{rest.map(render)}</div>
        </details>
      )}
    </div>
  );
}
