"use client";

import { useEffect } from "react";

/** The landing's one beacon (0067): a browser that ran our script opened the invite. Once. */
export function InviteBeacon({ token }: { token: string }) {
  useEffect(() => {
    void fetch("/api/inbjudan/klick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      keepalive: true,
    }).catch(() => {});
  }, [token]);
  return null;
}
