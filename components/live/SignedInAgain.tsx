"use client";

import { useEffect } from "react";
import { SIGNED_IN_CHANNEL } from "@/lib/live/signed-in";

/** "Du är inloggad igen": pings the meeting tab (BroadcastChannel) and asks to close this one. */
export function SignedInAgain() {
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(SIGNED_IN_CHANNEL);
    ch.postMessage("signed-in");
    ch.close();
  }, []);
  return (
    <section className="flex flex-col gap-2 rounded-lg bg-surface p-[clamp(1.5rem,4vw,2.5rem)] shadow-panel" aria-labelledby="signed-in-title">
      <h1 id="signed-in-title" className="text-2xl">
        Du är inloggad igen
      </h1>
      <p className="text-ink-2">Stäng den här fliken. Mötet fortsätter i den andra fliken, och det som väntade skickas nu.</p>
    </section>
  );
}
