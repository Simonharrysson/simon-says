"use client";

import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { IconCheck } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

// The settings' one save model: a toggle, a choice or an upload saves on change and says so
// quietly here ("Sparar…", then "Sparat" for a few seconds); only text fields have a Spara button,
// and that button reports through the same line. The line keeps its width, so nothing moves.

export type SaveStatus = { state: "idle" | "saving" | "saved" } | { state: "error"; message: string };

const IDLE: SaveStatus = { state: "idle" };

// Statuses kept above a part that the server may re-mount after its save (the calendar form
// streams in under <Suspense>): a keyed `useSaveState` keeps its "Sparat" across that.
const Kept = createContext<{ get: (key: string) => SaveStatus; set: (key: string, s: SaveStatus) => void } | null>(null);

export function SaveStatesProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<Record<string, SaveStatus>>({});
  const get = useCallback((key: string) => map[key] ?? IDLE, [map]);
  const set = useCallback((key: string, s: SaveStatus) => setMap((m) => ({ ...m, [key]: s })), []);
  return <Kept.Provider value={{ get, set }}>{children}</Kept.Provider>;
}

/** `run(work)`: shows saving, then saved (or the error `work` throws / returns as a string). */
export function useSaveState(key?: string) {
  const kept = useContext(Kept);
  const [local, setLocal] = useState<SaveStatus>(IDLE);
  const shared = Boolean(key && kept);
  const status = shared ? kept!.get(key!) : local;
  const setStatus = useCallback((s: SaveStatus) => (shared ? kept!.set(key!, s) : setLocal(s)), [shared, kept, key]);
  const runs = useRef(0);
  useEffect(() => {
    if (status.state !== "saved") return;
    const timer = setTimeout(() => setStatus(IDLE), 3000);
    return () => clearTimeout(timer);
  }, [status, setStatus]);
  const run = useCallback(async (work: () => Promise<string | null | void>): Promise<boolean> => {
    const mine = ++runs.current;
    setStatus({ state: "saving" });
    let error: string | null = null;
    try {
      error = (await work()) ?? null;
    } catch (e) {
      error = e instanceof Error && e.message ? e.message : "error";
    }
    // A later change owns the line now.
    if (mine === runs.current) setStatus(error ? { state: "error", message: error } : { state: "saved" });
    return !error;
  }, [setStatus]);
  const reset = useCallback(() => setStatus(IDLE), [setStatus]);
  return { status, run, reset };
}

/** The quiet status line. `className` places it; it reserves its own height. */
export function SaveState({ status, className, errorFallback }: { status: SaveStatus; className?: string; errorFallback?: string }) {
  const t = useTranslations("org.settings");
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex min-h-6 items-center gap-1 text-sm transition-opacity duration-200 ease-out",
        status.state === "saved" ? "font-medium text-green" : status.state === "error" ? "text-red" : "text-ink-3",
        status.state === "idle" && "opacity-0",
        className,
      )}
    >
      {status.state === "saving" && t("saving")}
      {status.state === "saved" && (
        <>
          <IconCheck size={16} /> {t("saved")}
        </>
      )}
      {status.state === "error" && (status.message === "error" ? (errorFallback ?? t("saveFailed")) : status.message)}
    </span>
  );
}
