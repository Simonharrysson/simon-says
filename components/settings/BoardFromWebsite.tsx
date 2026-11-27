"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { addBoardPersonAction } from "@/app/(app)/orgs/[id]/kom-igang/actions";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconAlert, IconCheck, IconGlobe } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { websiteLabel } from "@/lib/orgs/profile";
import { cn } from "@/lib/utils";
import type { BoardSuggestion } from "@/lib/website/board";

// "Hämta styrelsen från webbplatsen" (föreningar, Inställningar → Föreningen): asks the server to
// read the saved website, then shows who it found as a list the admin checks, corrects and adds.
// Nothing is saved until "Lägg till"; each person is added with the normal board action (name and
// role only: no e-mail is ever guessed). A failure is one quiet sentence; the settings still work.

interface Row extends BoardSuggestion {
  key: string;
  picked: boolean;
  error?: string;
}

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "empty" }
  | { phase: "found"; rows: Row[]; adding: boolean }
  | { phase: "done"; added: number };

export function BoardFromWebsite({ orgId, website, autoStart = 0 }: { orgId: string; website: string; autoStart?: number }) {
  const t = useTranslations("org.websiteBoard");
  const router = useRouter();
  const id = useId();
  const site = websiteLabel(website);
  const [state, setState] = useState<State>({ phase: "idle" });
  const busy = useRef(false);

  const fetchBoard = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setState({ phase: "loading" });
    try {
      const res = await fetch(`/api/orgs/${orgId}/board-from-website`, { method: "POST" });
      const json = (await res.json().catch(() => null)) as { people?: BoardSuggestion[]; message?: string } | null;
      if (!res.ok || !json?.people) setState({ phase: "error", message: json?.message ?? t("failed") });
      else if (json.people.length === 0) setState({ phase: "empty" });
      else
        setState({
          phase: "found",
          adding: false,
          rows: json.people.map((p, i) => ({ ...p, key: `${i}`, picked: !p.exists })),
        });
    } catch {
      setState({ phase: "error", message: t("failed") });
    }
    busy.current = false;
  }, [orgId, t]);

  // Spara saved a new website: read it at once (the parent bumps `autoStart`).
  useEffect(() => {
    if (autoStart > 0) void fetchBoard();
  }, [autoStart, fetchBoard]);

  const update = (key: string, patch: Partial<Row>) =>
    setState((s) => (s.phase === "found" ? { ...s, rows: s.rows.map((r) => (r.key === key ? { ...r, ...patch, error: undefined } : r)) } : s));

  const addPicked = async () => {
    if (state.phase !== "found") return;
    const picked = state.rows.filter((r) => r.picked && !r.exists);
    setState({ ...state, adding: true });
    let added = 0;
    const failed = new Map<string, string>();
    for (const row of picked) {
      const r = await addBoardPersonAction(orgId, { name: row.name, role: row.role, email: "" }).catch(() => ({ ok: false as const, message: t("addFailed") }));
      if (r.ok) added++;
      else failed.set(row.key, r.message);
    }
    if (added > 0) router.refresh();
    if (failed.size === 0) {
      setState({ phase: "done", added });
      return;
    }
    // Keep only the people who didn't make it, with why; the rest are on the board now.
    setState((s) =>
      s.phase === "found"
        ? {
            phase: "found",
            adding: false,
            rows: s.rows.flatMap((r) => (failed.has(r.key) ? [{ ...r, error: failed.get(r.key) }] : r.picked && !r.exists ? [] : [r])),
          }
        : s,
    );
  };

  const fetchButton = (label: string) => (
    <Button variant="secondary" icon={<IconGlobe />} onClick={() => void fetchBoard()}>
      {label}
    </Button>
  );

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-[0_1px_0_rgb(0_0_0/0.02)]">
      <div className="flex flex-col gap-1">
        <h3 id={`${id}-title`} className="text-base font-semibold">
          {t("title")}
        </h3>
        {state.phase === "idle" && <p className="max-w-[60ch] text-sm text-ink-2">{t("intro", { site })}</p>}
      </div>

      <div aria-live="polite" className="flex flex-col gap-4">
        {state.phase === "idle" && <div>{fetchButton(t("fetch"))}</div>}

        {state.phase === "loading" && (
          <p className="flex items-center gap-2 text-sm text-ink-2">
            <Spinner className="text-base" />
            {t("loading", { site })}
          </p>
        )}

        {state.phase === "error" && (
          <>
            <p className="flex items-start gap-2 text-sm text-ink-2">
              <IconAlert size={16} className="mt-[0.15rem] flex-none text-amber" />
              <span>{state.message}</span>
            </p>
            <div>{fetchButton(t("retry"))}</div>
          </>
        )}

        {state.phase === "empty" && (
          <>
            <p className="max-w-[60ch] text-sm text-ink-2">{t("empty", { site })}</p>
            <div>{fetchButton(t("retry"))}</div>
          </>
        )}

        {state.phase === "done" && (
          <p className="flex items-center gap-2 text-sm text-green">
            <IconCheck size={16} />
            {t("added", { count: state.added })}
          </p>
        )}

        {state.phase === "found" && <Found id={id} site={site} rows={state.rows} adding={state.adding} onChange={update} onAdd={() => void addPicked()} onDismiss={() => setState({ phase: "idle" })} />}
      </div>
    </section>
  );
}

function Found({
  id,
  site,
  rows,
  adding,
  onChange,
  onAdd,
  onDismiss,
}: {
  id: string;
  site: string;
  rows: Row[];
  adding: boolean;
  onChange: (key: string, patch: Partial<Row>) => void;
  onAdd: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations("org.websiteBoard");
  const fresh = rows.filter((r) => !r.exists);
  const picked = fresh.filter((r) => r.picked && r.name.trim());
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-ink-3">{t("foundOn", { site })}</p>
        <p className="font-medium">{t("foundCount", { count: rows.length })}</p>
      </div>
      <ul className="flex flex-col" aria-label={t("listLabel")}>
        {rows.map((r) => (
          <li key={r.key} className={cn("flex flex-col gap-1 border-t border-line py-3 first:border-t-0", r.exists && "opacity-70")}>
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1.4fr)_minmax(0,1fr)]">
              <Checkbox
                id={`${id}-${r.key}-pick`}
                checked={r.picked && !r.exists}
                disabled={r.exists || adding}
                onCheckedChange={(v) => onChange(r.key, { picked: v === true })}
                aria-label={t("pick", { name: r.name || t("unnamed") })}
              />
              <Input
                id={`${id}-${r.key}-name`}
                aria-label={t("nameLabel")}
                value={r.name}
                maxLength={60}
                disabled={r.exists || adding}
                onChange={(e) => onChange(r.key, { name: e.target.value })}
              />
              <Input
                id={`${id}-${r.key}-role`}
                aria-label={t("roleLabel", { name: r.name || t("unnamed") })}
                placeholder={t("rolePlaceholder")}
                value={r.role}
                maxLength={40}
                disabled={r.exists || adding}
                onChange={(e) => onChange(r.key, { role: e.target.value })}
                className="max-sm:col-start-2"
              />
            </div>
            {r.exists && (
              <span className="pl-8">
                <Badge>{t("exists")}</Badge>
              </span>
            )}
            {r.error && (
              <p className="flex items-center gap-1 pl-8 text-sm text-red">
                <IconAlert size={16} />
                {r.error}
              </p>
            )}
          </li>
        ))}
      </ul>
      <p className="max-w-[60ch] text-xs text-ink-3">{t("checkHint")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={onAdd} loading={adding} disabled={picked.length === 0}>
          {picked.length ? t("add", { count: picked.length }) : t("addNone")}
        </Button>
        <Button variant="ghost" onClick={onDismiss} disabled={adding}>
          {t("dismiss")}
        </Button>
      </div>
    </div>
  );
}
