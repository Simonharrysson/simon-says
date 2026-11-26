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
  if (banners.length === 0) return null;
  const connected = connection === "ok";

  const render = (kind: LiveBannerKind) => {
    switch (kind) {
      case "error": {
        // Retrying can't help once the meeting has used all its sessions (mint_cap).
        const final = refusal === "mint_cap";
        const text = final
          ? "Anslutningen till transkriberingen har brutits för många gånger i det här mötet. Avsluta och starta ett nytt möte. Det som redan sagts finns kvar i dokumentet."
          : streamError === "token"
            ? "Vi fick ingen kontakt med transkriberingen efter tre försök. Vi försöker igen var 30:e sekund och håller kvar det som sägs i upp till en minut. Det som redan sagts finns kvar i dokumentet."
            : streamError?.startsWith("mic")
              ? "Mikrofonen kunde inte startas. Kontrollera att den är på och att ingen annan app använder den. Det som redan sagts finns kvar i dokumentet."
              : "Inget ljud skickas just nu. Det som redan sagts finns kvar i dokumentet.";
        return (
          <Banner
            key="error"
            tone="danger"
            loud
            title={final ? "Starta ett nytt möte" : "Transkriberingen har stannat"}
            action={
              onRetry &&
              !final && (
                <Button variant="primary" icon={<IconRefresh size={18} />} onClick={onRetry}>
                  Försök igen
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
            title="Dokumentet pausat — logga in igen"
            action={
              onReLogin && (
                <Button variant="primary" onClick={onReLogin}>
                  Logga in igen
                </Button>
              )
            }
          >
            {connected
              ? "Google tog tillbaka behörigheten. Transkriberingen fortsätter, och allt skrivs in i dokumentet när du loggat in."
              : "Google tog tillbaka behörigheten. Allt skrivs in i dokumentet när du loggat in."}
          </Banner>
        );
      case "time":
        return (
          <Banner key="time" tone="danger" icon={<IconClock />} title={`Mötet avslutas automatiskt om ${minutesLeft} min`}>
            {limitWarningText(limitReason)}
          </Banner>
        );
      case "connection":
        return (
          <Banner
            key="conn"
            tone="warning"
            icon={<IconWifiOff />}
            title={retryInSeconds != null && retryInSeconds >= 5 ? `Ansluter igen om ${retryInSeconds} s` : "Ljudet väntar i webbläsaren"}
          >
            {connection === "offline"
              ? "Ingen internetanslutning. Ljudet hålls kvar i webbläsaren i upp till en minut och skickas när nätet är tillbaka. Inget sparas på datorn."
              : "Anslutningen bröts. Ljudet hålls kvar i webbläsaren i upp till en minut och skickas när vi är tillbaka. Du behöver inte göra något."}
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
            Visa {rest.length === 1 ? "1 varning" : `${rest.length} varningar`} till
            <IconChevronDown size={16} className="transition-transform duration-120 ease-out group-open/more:rotate-180" />
          </summary>
          <div className="flex flex-col gap-2">{rest.map(render)}</div>
        </details>
      )}
    </div>
  );
}
