import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { IconClock, IconDoc, IconWifiOff } from "@/components/ui/icons";
import type { ConnectionState } from "./types";

export interface LiveBannersProps {
  connection: ConnectionState;
  /** Google token revoked: transcription goes on, the Doc waits for a new login. */
  docPaused?: boolean;
  /** Minutes since the notes were last written, when over the 3-minute threshold. */
  staleMinutes?: number | null;
  /** Minutes left before the 4 h automatic stop, from 3 h 45 on. */
  minutesLeft?: number | null;
  onReLogin?: () => void;
}

/**
 * The meeting's health, most serious first. Each is one short sentence about what is
 * happening and what (if anything) to do. Nothing shows when all is well.
 */
export function LiveBanners({ connection, docPaused, staleMinutes, minutesLeft, onReLogin }: LiveBannersProps) {
  const items = [];
  if (docPaused) {
    items.push(
      <Banner
        key="doc"
        tone="danger"
        icon={<IconDoc />}
        title="Dokumentet pausat — logga in igen"
        action={
          onReLogin && (
            <Button variant="primary" size="sm" onClick={onReLogin}>
              Logga in igen
            </Button>
          )
        }
      >
        Google tog tillbaka behörigheten. Transkriptionen fortsätter, och allt skrivs in i dokumentet när du loggat in.
      </Banner>,
    );
  }
  if (connection !== "ok") {
    items.push(
      <Banner key="conn" tone="warning" icon={<IconWifiOff />} title="Ansluter igen…">
        {connection === "offline"
          ? "Ingen internetanslutning. Ljudet sparas på datorn i upp till en minut och skickas när nätet är tillbaka."
          : "Anslutningen bröts. Ljudet sparas under tiden och skickas så fort vi är tillbaka."}
      </Banner>,
    );
  }
  if (minutesLeft != null) {
    items.push(
      <Banner key="time" tone="warning" icon={<IconClock />} title={`Mötet avslutas automatiskt om ${minutesLeft} min`}>
        Ett möte kan vara högst 4 timmar. Behöver ni mer tid, avsluta och starta ett nytt möte.
      </Banner>,
    );
  }
  if (staleMinutes != null && !docPaused) {
    items.push(
      <Banner key="stale" tone="neutral" icon={<IconClock />} title={`Anteckningarna har inte uppdaterats på ${staleMinutes} min`}>
        Transkriptionen fungerar. Vi försöker igen automatiskt, du behöver inte göra något.
      </Banner>,
    );
  }
  if (items.length === 0) return null;
  return <div className="live-banners">{items}</div>;
}
