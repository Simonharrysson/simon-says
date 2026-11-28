"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { refreshMemoryAction, saveMemoryAction, type MemoryActionResult } from "@/app/(app)/orgs/memory-actions";
import { Button } from "@/components/ui/button";
import { IconPlus, IconRefresh, IconX } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/Panel";
import { meetingDayLabel } from "@/lib/home/tasks";
import { attributionOf, attributionParts } from "@/lib/memory/attribution";
import { MAX_LINE, MEMORY_SECTIONS, type MemoryLine, type MemorySection } from "@/lib/memory/memory";
import type { OrgMemory as Memory, SourceMeeting } from "@/lib/memory/store";

// Inställningar → Vad Claude ska veta (0065): the admins' editor of what their members' Claude
// reads (get_org_memory). Uppdatera asks Claude for a fresh draft from the meetings every member
// can see; lines the admins wrote or changed stay. Every line is an attributed statement: under it,
// who said it in which meeting (the date links to it), "Tillagt av <admin>", or for an older line
// the meeting it came from.

type Draft = { key: string; id: string | null; section: MemorySection; text: string; line: MemoryLine | null };

const toDraft = (l: MemoryLine): Draft => ({ key: l.id, id: l.id, section: l.section, text: l.text, line: l });

export function OrgMemory({
  orgId,
  memory,
  sources,
  save = saveMemoryAction,
  refresh = refreshMemoryAction,
}: {
  orgId: string;
  memory: Memory;
  /** The source meetings the admin can see, for the links. */
  sources: Record<string, SourceMeeting>;
  save?: (orgId: string, edits: { id: string | null; section: string; text: string }[], seenIds: string[]) => Promise<MemoryActionResult>;
  refresh?: (orgId: string) => Promise<MemoryActionResult>;
}) {
  const t = useTranslations("memory");
  const locale = useLocale() === "en" ? "en" : "sv";
  const titleId = useId();
  const [lines, setLines] = useState<Draft[]>(() => memory.lines.map(toDraft));
  const [seen, setSeen] = useState(memory);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<MemoryActionResult | null>(null);
  const [saving, startSave] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  // A new page from the server (after Uppdatera or a save): show it, unless the admin is mid-edit.
  if (seen !== memory) {
    setSeen(memory);
    if (!dirty) setLines(memory.lines.map(toDraft));
  }

  const change = (key: string, patch: Partial<Draft>) => {
    setDirty(true);
    setMessage(null);
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const remove = (key: string) => {
    setDirty(true);
    setMessage(null);
    setLines((all) => all.filter((l) => l.key !== key));
  };
  const add = (section: MemorySection) => {
    setDirty(true);
    setMessage(null);
    setLines((all) => [...all, { key: `new-${Date.now().toString(36)}-${all.length}`, id: null, section, text: "", line: null }]);
  };
  const onSave = () =>
    startSave(async () => {
      const r = await save(
        orgId,
        lines.map((l) => ({ id: l.id, section: l.section, text: l.text })),
        // The lines this page showed: only those are changed or removed by the save.
        memory.lines.map((l) => l.id),
      );
      setMessage(r);
      if (r.ok) setDirty(false);
    });
  const onRefresh = () =>
    startRefresh(async () => {
      const r = await refresh(orgId);
      setMessage(r);
      if (r.ok) setDirty(false);
    });

  const built =
    memory.generatedAt && memory.sourcesFrom
      ? t("builtFrom", { count: memory.sourcesCount, date: meetingDayLabel(memory.sourcesFrom, locale) })
      : t("notBuilt");

  return (
    <Panel
      title={t("title")}
      titleId={titleId}
      actions={
        <Button variant="secondary" size="sm" icon={<IconRefresh />} loading={refreshing} disabled={refreshing || saving || dirty} onClick={onRefresh}>
          {refreshing ? t("refreshing") : t("refreshButton")}
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        <div className="flex max-w-[68ch] flex-col gap-2 text-sm text-ink-2">
          <p>{t("intro")}</p>
          <p className="text-ink-3">{t("readers")}</p>
          <p className="text-ink-3" data-memory-built>
            {built}
          </p>
        </div>

        {lines.length === 0 && <p className="text-sm text-ink-3">{t("empty")}</p>}

        {MEMORY_SECTIONS.map((section) => {
          const mine = lines.filter((l) => l.section === section);
          const headingId = `${titleId}-${section}`;
          return (
            <section key={section} aria-labelledby={headingId} className="flex flex-col gap-2">
              <h3 id={headingId} className="text-base font-semibold text-ink">
                {t(`sections.${section}`)}
              </h3>
              {mine.length > 0 ? (
                <ul aria-labelledby={headingId} className="flex flex-col">
                  {mine.map((l, i) => (
                    <li key={l.key} className="flex flex-col gap-1.5 border-t border-line py-3 first:border-t-0 first:pt-1">
                      <div className="flex items-start gap-2">
                        <Input
                          value={l.text}
                          maxLength={MAX_LINE}
                          aria-label={t("lineLabel", { section: t(`sections.${section}`), n: i + 1 })}
                          onChange={(e) => change(l.key, { text: e.target.value })}
                          className="min-w-0 flex-1"
                        />
                        <Button variant="ghost" size="md" iconOnly icon={<IconX />} aria-label={t("remove")} onClick={() => remove(l.key)} />
                      </div>
                      <Attribution draft={l} orgId={orgId} sources={sources} locale={locale} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-3">{t("sectionEmpty")}</p>
              )}
              <div>
                <Button variant="ghost" size="sm" icon={<IconPlus />} onClick={() => add(section)}>
                  {t("addLine")}
                </Button>
              </div>
            </section>
          );
        })}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" loading={saving} disabled={saving || refreshing || !dirty} onClick={onSave}>
            {saving ? t("saving") : t("save")}
          </Button>
          <p role="status" aria-live="polite" className={message && !message.ok ? "text-sm text-red" : "text-sm text-ink-2"}>
            {message ? message.message : dirty ? t("unsaved") : ""}
          </p>
        </div>
      </div>
    </Panel>
  );
}

/**
 * Under a line: who said it in which meeting (the date links to the meeting page), "Tillagt av
 * <admin>", or "Från mötet <date>" for a line from before attribution. A line the admin is
 * changing (or a new one) is theirs once saved: "Tillagt av dig".
 */
function Attribution({
  draft,
  orgId,
  sources,
  locale,
}: {
  draft: Draft;
  orgId: string;
  sources: Record<string, SourceMeeting>;
  locale: "sv" | "en";
}) {
  const t = useTranslations("memory");
  const mine = !draft.line || draft.text.trim() !== draft.line.text || draft.section !== draft.line.section;
  if (mine)
    return (
      <p className="text-xs text-ink-3" data-memory-attribution>
        {t("addedByYou")}
      </p>
    );
  const line = draft.line!;
  const dates = Object.fromEntries(Object.values(sources).map((m) => [m.id, m.date]));
  const parts = attributionParts(attributionOf(line), dates, locale);
  const named = new Set(parts.meetings.map((m) => m.id));
  const more = line.sources.filter((id) => !named.has(id) && sources[id]);
  const link = (id: string, label: string) => (
    <a href={`/orgs/${orgId}/mote/${id}`} className="text-ink-3 underline underline-offset-2 hover:text-ink" title={sources[id]?.title ?? undefined}>
      {label}
    </a>
  );
  return (
    <p className="text-xs text-ink-3" data-memory-attribution>
      {parts.lead}{" "}
      {parts.meetings.map((m, i) => (
        <span key={m.id}>
          {i > 0 && ", "}
          {sources[m.id] ? link(m.id, m.label) : m.label}
        </span>
      ))}
      {more.length > 0 && (
        <>
          {" · "}
          {t("alsoIn")}{" "}
          {more.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              {link(id, sources[id].title ?? t("sourceLink", { date: meetingDayLabel(sources[id].date, locale) }))}
            </span>
          ))}
        </>
      )}
    </p>
  );
}
