"use client";

import { useId, useState } from "react";
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

/**
 * Before Start. The runner confirms everyone in the room knows the meeting is transcribed
 * (logged per meeting); Start stays disabled until then.
 */
export function ConsentStep({
  orgName,
  shareTranscript,
  onStart,
  starting,
  error,
}: {
  orgName: string;
  /** Whether the transcript gets its own tab in the Doc (org setting). */
  shareTranscript: boolean;
  onStart: () => void;
  starting?: boolean;
  error?: StartError;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const id = useId();
  const problem = error ? startErrors[error] : null;
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
        <li>Paus stoppar ljudet direkt. Ingen ljudinspelning sparas.</li>
      </ul>

      {problem && (
        <Banner tone="danger" icon={error?.startsWith("mic") ? <IconMicOff /> : undefined} title={problem.title}>
          {problem.text}
        </Banner>
      )}

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
