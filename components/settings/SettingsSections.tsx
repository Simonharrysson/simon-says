"use client";

import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Activity, createContext, useContext, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { HASH_SECTIONS, isSettingsSection, SETTINGS_SECTIONS, type SettingsSectionId } from "@/lib/orgs/tabs";
import { cn } from "@/lib/utils";

/**
 * Inställningar's sub-nav and its five sections (Föreningen · Styrelsen och medlemmar · Möten ·
 * Efter mötet · Radera). Every section is rendered by the server; a click shows another one at
 * once (kept mounted in <Activity>, so drafts survive) and records it in the URL
 * (`?flik=installningar&del=moten`, pushState: deep-linkable, reloadable, back works). A sidebar
 * from 1024 px, a row of chips below.
 *
 * Which section shows: `?del=` when the URL has one; otherwise the last one chosen here (the tab
 * link carries no `del`, so coming back to the tab keeps it), or `initial` from the server (a
 * form's message opens the section it is about; re-synced whenever the server's choice changes).
 */

const SectionNav = createContext<(id: SettingsSectionId) => void>(() => {});

/** Show another section (e.g. Röster's "Lägg till styrelsen" → Styrelsen och medlemmar). */
export const useSettingsSection = () => useContext(SectionNav);

export function SettingsSections({ initial, sections }: { initial: SettingsSectionId; sections: Record<SettingsSectionId, ReactNode> }) {
  const t = useTranslations("org.settings");
  const params = useSearchParams();
  const del = params.get("del");
  const [kept, setKept] = useState(initial);
  const [seenInitial, setSeenInitial] = useState(initial);
  const [switched, setSwitched] = useState(false);
  if (seenInitial !== initial) {
    setSeenInitial(initial);
    setKept(initial);
  }
  if (isSettingsSection(del) && del !== kept) setKept(del);
  const active: SettingsSectionId = isSettingsSection(del) ? del : kept;

  const hrefFor = (id: SettingsSectionId) => {
    const next = new URLSearchParams(params.toString());
    next.set("flik", "installningar");
    next.set("del", id);
    // A form's message belongs to the section it came from.
    next.delete("fel");
    next.delete("klart");
    return `?${next.toString()}`;
  };
  const show = (id: SettingsSectionId, how: "push" | "replace" = "push") => {
    if (id === active) return;
    setSwitched(true);
    setKept(id);
    window.history[how === "push" ? "pushState" : "replaceState"](null, "", hrefFor(id));
  };

  // An old link to the one long page (`#sammanfattning` in a summary e-mail) opens its section.
  useEffect(() => {
    const id = HASH_SECTIONS[window.location.hash];
    if (id && !isSettingsSection(new URLSearchParams(window.location.search).get("del"))) {
      setKept(id);
      window.history.replaceState(null, "", `${hrefFor(id)}`);
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onNav = (e: MouseEvent<HTMLAnchorElement>, id: SettingsSectionId) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    show(id);
  };

  return (
    <SectionNav.Provider value={show}>
      <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
        <nav aria-label={t("navLabel")} className="lg:sticky lg:top-20">
          <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-0.5">
            {SETTINGS_SECTIONS.map((id) => (
              <li key={id}>
                <a
                  href={hrefFor(id)}
                  onClick={(e) => onNav(e, id)}
                  aria-current={id === active ? "true" : undefined}
                  className={cn(
                    "inline-flex min-h-10 items-center rounded-full border border-line bg-surface px-3.5 text-sm font-medium text-ink-2 no-underline transition-colors duration-150 ease-out hover:border-control hover:text-ink hover:no-underline max-md:min-h-11",
                    "aria-[current=true]:border-ink aria-[current=true]:bg-ink aria-[current=true]:text-on-ink",
                    "lg:flex lg:min-h-9 lg:w-full lg:rounded-md lg:border-transparent lg:bg-transparent lg:px-3 lg:hover:border-transparent lg:hover:bg-sunk",
                    "lg:aria-[current=true]:border-transparent lg:aria-[current=true]:bg-sunk lg:aria-[current=true]:text-ink",
                    id === "radera" && "lg:mt-3",
                  )}
                >
                  {t(`sections.${id}`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">
          {SETTINGS_SECTIONS.map((id) => (
            <Activity key={id} mode={id === active ? "visible" : "hidden"}>
              <div
                data-settings-section={id}
                className={cn("flex flex-col gap-6", switched && "motion-safe:animate-[tab-in_180ms_var(--ease-out)_backwards]")}
              >
                {sections[id]}
              </div>
            </Activity>
          ))}
        </div>
      </div>
    </SectionNav.Provider>
  );
}
