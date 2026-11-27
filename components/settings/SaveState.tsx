"use client";

import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { IconCheck } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

// The settings' one save model: a toggle, a choice or an upload saves on change and says so
// quietly here ("Sparar…", then "Sparat" for a few seconds, only after the save is confirmed);
// only text fields have a Spara button, and that button reports through the same line. The line
// keeps its place, so nothing moves.

export type SaveStatus = { state: "idle" | "saving" | "saved" } | { state: "error"; message: string };

const IDLE: SaveStatus = { state: "idle" };

// Statuses kept above a part that the server may re-mount after its save (the calendar form
// streams in under <Suspense>): a keyed status keeps its "Sparat" across that.
const Kept = createContext<{ get: (key: string) => SaveStatus; set: (key: string, s: SaveStatus) => void } | null>(null);

export function SaveStatesProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<Record<string, SaveStatus>>({});
  const get = useCallback((key: string) => map[key] ?? IDLE, [map]);
  const set = useCallback((key: string, s: SaveStatus) => setMap((m) => ({ ...m, [key]: s })), []);
  return <Kept.Provider value={{ get, set }}>{children}</Kept.Provider>;
}

/** The status line's state: local, or kept by `SaveStatesProvider` under `key`. "Sparat" fades after 3 s. */
function useStatus(key?: string) {
  const kept = useContext(Kept);
  const [local, setLocal] = useState<SaveStatus>(IDLE);
  const shared = Boolean(key && kept);
  const status = shared ? kept!.get(key!) : local;
  const setStatus = useCallback((s: SaveStatus) => (shared ? kept!.set(key!, s) : setLocal(s)), [shared, kept, key]);
  useEffect(() => {
    if (status.state !== "saved") return;
    const timer = setTimeout(() => setStatus(IDLE), 3000);
    return () => clearTimeout(timer);
  }, [status, setStatus]);
  return { status, setStatus };
}

/** `run(work)`: shows saving, then saved (or the error `work` throws / returns as a string). For Spara buttons. */
export function useSaveState(key?: string) {
  const { status, setStatus } = useStatus(key);
  const runs = useRef(0);
  const run = useCallback(
    async (work: () => Promise<string | null | void>): Promise<boolean> => {
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
    },
    [setStatus],
  );
  return { status, run };
}

/**
 * A value that saves on change (a switch, a choice). Changes are saved one at a time, in order:
 * one made while a save runs waits and only the latest waiting one is sent. The value shown is
 * the optimistic one; a failed save rolls back to the last confirmed value and says why. The
 * server's value (props after the save's revalidation) is taken only when nothing is saving or
 * waiting, so an older answer never overwrites a newer choice.
 */
export function useSavedValue<T>(server: T, save: (value: T) => Promise<string | null>, key?: string) {
  const { status, setStatus } = useStatus(key);
  const serverKey = JSON.stringify(server);
  const [value, setValue] = useState(server);
  const [seen, setSeen] = useState(serverKey);
  const [busy, setBusy] = useState(false);
  const confirmed = useRef(server);
  const running = useRef(false);
  const waiting = useRef<{ value: T } | null>(null);
  if (seen !== serverKey) {
    setSeen(serverKey);
    if (!busy) setValue(server);
  }
  useEffect(() => {
    if (!running.current && !waiting.current) confirmed.current = JSON.parse(serverKey) as T;
  }, [serverKey]);

  const pump = async () => {
    running.current = true;
    setBusy(true);
    setStatus({ state: "saving" });
    while (waiting.current) {
      const next = waiting.current.value;
      waiting.current = null;
      let error: string | null;
      try {
        error = await save(next);
      } catch {
        error = "error";
      }
      if (error) {
        waiting.current = null;
        running.current = false;
        setBusy(false);
        setValue(confirmed.current);
        setStatus({ state: "error", message: error });
        return;
      }
      confirmed.current = next;
    }
    running.current = false;
    setBusy(false);
    setStatus({ state: "saved" });
  };

  const change = (next: T) => {
    setValue(next);
    waiting.current = { value: next };
    if (!running.current) void pump();
  };

  return { value, change, status, confirmed: () => confirmed.current };
}

const noSubscribe = () => () => {};

/**
 * False in the server's HTML and until this part has hydrated. A `<select>` that saves on change
 * must wait for it: React replays a click made before hydration (switches, radios) but not a
 * select's change event, so a choice made in that window would show and never be saved. Parts
 * that stream in under <Suspense> (the calendar) hydrate last.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
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
