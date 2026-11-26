"use client";

import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { IconExternal } from "@/components/ui/icons";

/**
 * A member who hasn't got a meeting's Doc (joined later, or the share failed): "Få åtkomst" asks
 * Simon Says to share it through the starter (POST /api/meetings/<id>/doc-access). Then the
 * "Dokument" link; if that can't be done, a plain line naming who to ask. Never a link to Google's
 * access-denied page.
 */
export function DocAccessButton({ meetingId, docHref, starter }: { meetingId: string; docHref: string; starter: string }) {
  const [state, setState] = useState<"idle" | "busy" | "open" | "ask">("idle");

  const ask = async () => {
    setState("busy");
    try {
      const res = await fetch(`/api/meetings/${meetingId}/doc-access`, { method: "POST" });
      setState(res.ok ? "open" : "ask");
    } catch {
      setState("ask");
    }
  };

  if (state === "open") {
    return (
      <a className={buttonVariants({ size: "sm" })} href={docHref} target="_blank" rel="noopener noreferrer">
        Dokument
        <IconExternal size={16} />
        <span className="sr-only">(öppnas i ny flik)</span>
      </a>
    );
  }
  if (state === "ask") {
    return (
      <span role="status" className="text-sm text-ink-3">
        Be {starter} dela dokumentet med dig.
      </span>
    );
  }
  return (
    <Button size="sm" variant="secondary" loading={state === "busy"} onClick={() => void ask()}>
      Få åtkomst
    </Button>
  );
}
