"use client";

import { useEffect, useId, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { IconMic, IconMicOff } from "@/components/ui/icons";

export type StartError = "mic-denied" | "mic-missing" | "start-failed" | "limit" | null;

const startErrors: Record<Exclude<StartError, null>, { title: string; text: string }> = {
  "mic-denied": {
    title: "Mikrofonen är blockerad",
    text: "Klicka på hänglåset eller mikrofonikonen i adressfältet, välj Tillåt och tryck Starta igen.",
  },
  "mic-missing": {
    title: "Hittar ingen mikrofon",
    text: "Kontrollera att datorn har en mikrofon som är på, och att ingen annan app använder den.",
  },
  "start-failed": { title: "Mötet kunde inte starta", text: "Något gick fel hos oss. Försök igen om en liten stund." },
  limit: {
    title: "Månadens tid är slut",
    text: "Föreningen har använt sina 20 timmar den här månaden. Tiden fylls på den 1:a.",
  },
};

/** The banner for a start error; `text` replaces the default explanation (e.g. the server's own message). */
export function StartErrorBanner({ error, text }: { error: Exclude<StartError, null>; text?: string | null }) {
  const problem = startErrors[error];
  return (
    <Banner tone="danger" icon={error.startsWith("mic") ? <IconMicOff /> : undefined} title={problem.title}>
      {text ?? problem.text}
    </Banner>
  );
}

/** Input level above this counts as "we hear you". */
const HEARD = 0.08;

/**
 * Before Start. The runner confirms everyone in the room knows the meeting is transcribed
 * (logged per meeting); Start stays disabled until then. An optional mic check shows a level
 * meter, so a dead mic is found before Start, not in front of everyone.
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
}: {
  orgName: string;
  /** Whether the transcript gets its own tab in the Doc (org setting). */
  shareTranscript: boolean;
  onStart: () => void;
  starting?: boolean;
  error?: StartError;
  /** Replaces the error's default explanation (e.g. the server's Swedish message). */
  errorText?: string | null;
  /** Mic input level 0–1 while the check runs; null/undefined before it has started. */
  micLevel?: number | null;
  /** Ask for the mic and start reporting `micLevel`. Without it, no mic check is shown. */
  onMicCheck?: () => void;
}) {
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
  return (
    <section className="consent" aria-labelledby={`${id}-title`}>
      <div className="consent__head">
        <p className="muted">{orgName}</p>
        <h1 id={`${id}-title`} className="consent__title">
          Innan ni börjar
        </h1>
      </div>

      <ul className="consent__facts">
        <li>Laptopen lyssnar med sin egen mikrofon. Ställ den mitt på bordet.</li>
        <li>
          Anteckningarna skrivs i ett nytt Google-dokument i din Drive och delas med föreningens medlemmar
          {shareTranscript ? ", med hela transkriptionen i en egen flik." : ". Transkriptionen delas inte."}
        </li>
        <li>Paus stoppar ljudet direkt.</li>
        <li>Låt locket vara öppet och sätt i laddaren – stängs locket slutar laptopen lyssna.</li>
      </ul>

      {(onMicCheck || testing) && (
        <div className="miccheck">
          <span className="miccheck__label">Mikrofon</span>
          {testing ? (
            <>
              <span className="miccheck__meter" role="meter" aria-valuemin={0} aria-valuemax={5} aria-valuenow={bars} aria-label="Ljudnivå">
                {[1, 2, 3, 4, 5].map((n) => (
                  <span key={n} className={`miccheck__bar${n <= bars ? " is-on" : ""}`} />
                ))}
              </span>
              <span className={`miccheck__state${heard ? " is-heard" : ""}`} aria-hidden="true">
                {heard ? "Hör dig" : "Hör inget än. Säg något."}
              </span>
              <span className="visually-hidden" aria-live="polite">
                {everHeard ? "Mikrofonen fungerar, vi hör dig." : "Testar mikrofonen. Säg något."}
              </span>
            </>
          ) : (
            <Button icon={<IconMic size={18} />} onClick={onMicCheck}>
              Testa mikrofonen
            </Button>
          )}
        </div>
      )}

      {error && <StartErrorBanner error={error} text={errorText} />}

      <label className={`consent__check${confirmed ? " is-checked" : ""}`} htmlFor={`${id}-ok`}>
        <input
          id={`${id}-ok`}
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          disabled={starting}
        />
        <span>Alla i rummet vet att mötet transkriberas och kan be om paus</span>
      </label>

      <Button
        variant="primary"
        size="lg"
        block
        icon={<IconMic />}
        disabled={!confirmed}
        loading={starting}
        onClick={onStart}
        aria-describedby={!confirmed ? `${id}-why` : undefined}
      >
        {starting ? "Startar…" : "Starta mötet"}
      </Button>
      {!confirmed && (
        <p id={`${id}-why`} className="hint consent__why">
          Kryssa i rutan ovan först.
        </p>
      )}
    </section>
  );
}
