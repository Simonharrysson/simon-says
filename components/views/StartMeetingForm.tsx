"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { IconMic } from "@/components/ui/icons";

/**
 * "Starta möte" on the org page: the consent checkbox gates the button; POST /api/meetings
 * creates the Doc and the meeting. The server's Swedish message is shown as is. On success the
 * page is refreshed, so the new meeting shows up in the list with its Doc link.
 */
export function StartMeetingForm({ orgId, shareTranscript }: { orgId: string; shareTranscript: boolean }) {
  const router = useRouter();
  const id = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, consent: true }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      const json = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(json?.message ?? "Mötet kunde inte starta. Försök igen om en liten stund.");
    } catch {
      setError("Vi nådde inte servern. Kontrollera nätet och försök igen.");
    }
    setStarting(false);
  }

  return (
    <div className="stack stack--3">
      <p className="subtle">
        Vi skapar ett nytt Google-dokument i din Drive och delar det med föreningens medlemmar
        {shareTranscript ? ", med transkriptionen i en egen flik." : ". Transkriptionen delas inte."}
      </p>
      {error && (
        <Banner tone="danger" title="Mötet kunde inte starta">
          {error}
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
      <div>
        <Button
          variant="primary"
          size="lg"
          icon={<IconMic />}
          disabled={!confirmed}
          loading={starting}
          onClick={start}
          aria-describedby={!confirmed ? `${id}-why` : undefined}
        >
          {starting ? "Startar…" : "Starta möte"}
        </Button>
        {!confirmed && (
          <p id={`${id}-why`} className="hint">
            Kryssa i rutan ovan först.
          </p>
        )}
      </div>
    </div>
  );
}
