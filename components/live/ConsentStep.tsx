"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconMic, IconMicOff } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

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
export function StartErrorBanner({
  error,
  text,
  action,
}: {
  error: Exclude<StartError, null>;
  text?: string | null;
  action?: ReactNode;
}) {
  const problem = startErrors[error];
  return (
    <Banner tone="danger" icon={error.startsWith("mic") ? <IconMicOff /> : undefined} title={problem.title} action={action}>
      {text ?? problem.text}
    </Banner>
  );
}

/** Input level above this counts as "we hear you". */
const HEARD = 0.08;

/**
 * Before Start. The runner confirms everyone in the room knows the meeting is transcribed
 * (logged per meeting); Start stays disabled until then. An optional mic check shows a level
 * meter, so a dead mic is found before Start, not in front of everyone. `agenda` (the
 * AgendaStep) renders under the consent checkbox; Start also waits for `agendaConfirmed`.
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
  agenda,
  agendaConfirmed = true,
  agendaDoc = null,
  onNewDocInstead,
  privat = false,
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
  /** The agenda step (AgendaStep), shown under the consent checkbox. */
  agenda?: ReactNode;
  /** The agenda choice is confirmed (Använd, a Picker pick, or "Skapa nytt dokument"). */
  agendaConfirmed?: boolean;
  /** The meeting runs in the förening's own agenda Doc (the facts say so). */
  agendaDoc?: { transcriptInDoc: boolean } | null;
  /** After an agenda_* start error: "Skapa nytt dokument i stället" in the error banner. */
  onNewDocInstead?: () => void;
  /** A Privat recording (0045): the facts and hints speak of the user's own notes, not a förening's Doc. */
  privat?: boolean;
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
    <section className="flex flex-col gap-6 rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel" aria-labelledby={`${id}-title`}>
      <div className="flex flex-col gap-1">
        <p className="text-ink-2">{orgName}</p>
        <h1 id={`${id}-title`} className="text-2xl">
          Innan ni börjar
        </h1>
      </div>

      <ul className="flex list-dash flex-col gap-2 pl-[1.1rem] text-sm text-ink-2 marker:text-ink-3">
        <li>Laptopen lyssnar med sin egen mikrofon. Ställ den mitt på bordet.</li>
        {privat ? (
          <li>Anteckningarna sparas bara hos dig i Privat. Efter inspelningen får du en sammanfattning på mejlen.</li>
        ) : agendaDoc ? (
          <li>
            Anteckningarna skrivs i den valda dagordningen
            {agendaDoc.transcriptInDoc ? ", med hela transkriptet i en egen flik." : ". Transkriptet läggs inte i dokumentet."}
          </li>
        ) : (
          <li>
            Anteckningarna skrivs i ett nytt Google-dokument i din Drive och delas med föreningens medlemmar
            {shareTranscript ? ", med hela transkriptionen i en egen flik." : ". Transkriptionen delas inte."}
          </li>
        )}
        <li>Paus stoppar ljudet direkt.</li>
        <li>Låt locket vara öppet och sätt i laddaren – stängs locket slutar laptopen lyssna.</li>
      </ul>

      {(onMicCheck || testing) && (
        <div className="flex min-h-11 flex-wrap items-center gap-3 text-sm">
          <span className="font-semibold">Mikrofon</span>
          {testing ? (
            <>
              <span className="inline-flex h-5 items-end gap-[3px]" role="meter" aria-valuemin={0} aria-valuemax={5} aria-valuenow={bars} aria-label="Ljudnivå">
                {["h-[30%]", "h-[45%]", "h-[60%]", "h-[80%]", "h-full"].map((height, i) => (
                  <span key={height} className={cn("w-[6px] rounded-[2px]", height, i < bars ? "bg-green" : "bg-line")} />
                ))}
              </span>
              <span className={heard ? "font-semibold text-green" : "text-ink-2"} aria-hidden="true">
                {heard ? "Hör dig" : "Hör inget än. Säg något."}
              </span>
              <span className="sr-only" aria-live="polite">
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

      {error && (
        <StartErrorBanner
          error={error}
          text={errorText}
          action={
            onNewDocInstead ? (
              <Button size="sm" onClick={onNewDocInstead}>
                Skapa nytt dokument i stället
              </Button>
            ) : undefined
          }
        />
      )}

      <label
        className={cn(
          "grid cursor-pointer grid-cols-[auto_1fr] items-center gap-3 rounded-lg border border-control p-4 leading-[1.35] font-medium transition-colors duration-120 hover:border-ink-3",
          confirmed && "border-green bg-green-wash hover:border-green",
        )}
        htmlFor={`${id}-ok`}
      >
        <Checkbox id={`${id}-ok`} tone="green" checked={confirmed} onCheckedChange={(on) => setConfirmed(on === true)} disabled={starting} />
        <span>Alla i rummet vet att mötet transkriberas och kan be om paus</span>
      </label>

      {agenda}

      <Button
        variant="primary"
        size="lg"
        block
        icon={<IconMic />}
        disabled={!confirmed || !agendaConfirmed}
        loading={starting}
        onClick={onStart}
        aria-describedby={!confirmed || !agendaConfirmed ? `${id}-why` : undefined}
      >
        {starting ? "Startar…" : "Starta mötet"}
      </Button>
      {(!confirmed || !agendaConfirmed) && (
        <p id={`${id}-why`} className="-mt-4 text-center text-xs text-ink-3">
          {!confirmed ? "Kryssa i rutan ovan först." : privat ? "Välj vad inspelningen gäller först." : "Välj dagordning eller skapa ett nytt dokument först."}
        </p>
      )}
    </section>
  );
}
