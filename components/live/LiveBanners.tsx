import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { IconChevronDown, IconClock, IconDoc, IconRefresh, IconWifiOff } from "@/components/ui/icons";
import type { LiveBannerKind } from "@/lib/ui/live-status";
import type { ConnectionState } from "./types";

export interface LiveBannersProps {
  /** From `liveStatus()`: most urgent first. Only the first is shown in full. */
  banners: LiveBannerKind[];
  connection: ConnectionState;
  /** Minutes left before the 4 h automatic stop, from 3 h 45 on. */
  minutesLeft?: number | null;
  onReLogin?: () => void;
  onRetry?: () => void;
}

/**
 * Every red banner (user must act), most urgent first; a self-fixing one is shown alone or
 * waits behind "Visa 1 varning till". Red only when the user must act (stopped, Doc paused,
 * time running out); things that fix themselves are ink.
 */
export function LiveBanners({ banners, connection, minutesLeft, onReLogin, onRetry }: LiveBannersProps) {
  if (banners.length === 0) return null;
  const connected = connection === "ok";

  const render = (kind: LiveBannerKind) => {
    switch (kind) {
      case "error":
        return (
          <Banner
            key="error"
            tone="danger"
            className="banner--loud"
            title="Transkriptionen har stannat"
            action={
              onRetry && (
                <Button variant="primary" icon={<IconRefresh size={18} />} onClick={onRetry}>
                  Försök igen
                </Button>
              )
            }
          >
            Vi fick ingen kontakt med transkriberingen efter tre försök. Inget ljud skickas just nu. Det som redan sagts finns
            kvar i dokumentet.
          </Banner>
        );
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
              ? "Google tog tillbaka behörigheten. Transkriptionen fortsätter, och allt skrivs in i dokumentet när du loggat in."
              : "Google tog tillbaka behörigheten. Allt skrivs in i dokumentet när du loggat in."}
          </Banner>
        );
      case "time":
        return (
          <Banner key="time" tone="danger" icon={<IconClock />} title={`Mötet avslutas automatiskt om ${minutesLeft} min`}>
            Ett möte kan vara högst 4 timmar. Behöver ni mer tid, avsluta och starta ett nytt möte.
          </Banner>
        );
      case "connection":
        return (
          <Banner key="conn" tone="warning" icon={<IconWifiOff />} title="Ljudet väntar i webbläsaren">
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
    <div className="live-banners">
      {shown.map(render)}
      {rest.length > 0 && (
        <details className="live-banners__more">
          <summary>
            Visa {rest.length === 1 ? "1 varning" : `${rest.length} varningar`} till
            <IconChevronDown size={16} className="live-banners__chevron" />
          </summary>
          <div className="live-banners__rest">{rest.map(render)}</div>
        </details>
      )}
    </div>
  );
}
