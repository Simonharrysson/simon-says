"use client";

import { useTranslations } from "next-intl";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { IconCheck, IconPencil, IconPlus } from "@/components/ui/icons";
import { speakerKeyString, type PersonOption, type Speaker, type SpeakerChoice, type SpeakerKey } from "./types";

/**
 * Who is talking. Each diarized label is a name plate: "Talare 2 → Anna". Unsure names show
 * "Anna?" with a one-tap Stämmer; unknown ones (e.g. after a reconnect) ask "Vem är detta?"
 * with a Välj button that opens the meeting's names. Pickers stay closed until asked for,
 * so the list stays calm. Renames apply from the next lines onwards.
 */
export function SpeakerList({
  speakers,
  people,
  onAssign,
}: {
  speakers: Speaker[];
  /** Names to offer: the org's person list (meeting attendees first is a good order). */
  people: PersonOption[];
  onAssign: (speaker: SpeakerKey, choice: SpeakerChoice) => void;
}) {
  const t = useTranslations("live.speakers");
  const [editing, setEditing] = useState<string | null>(null);
  const unknown = speakers.filter((s) => !s.displayName || s.needsConfirm).length;

  return (
    <section className="flex flex-col overflow-hidden rounded-lg bg-surface shadow-panel" aria-labelledby="speakers-title">
      <div className="flex items-center justify-between gap-3 px-6 py-4">
        <h2 id="speakers-title" className="text-lg tracking-[-0.02em]">
          {t("title")}
        </h2>
        {unknown > 0 && (
          <Badge tone="info">{t("toConfirm", { count: unknown })}</Badge>
        )}
      </div>
      {speakers.length === 0 ? (
        <p className="px-6 pb-6 text-sm text-ink-3">{t("empty")}</p>
      ) : (
        <ul>
          {speakers.map((speaker) => {
            const key = speakerKeyString(speaker);
            const open = editing === key;
            const toggle = () => setEditing(open ? null : key);
            return (
              <li key={key} className="border-t border-line px-6 py-3">
                <div className="flex min-h-11 items-center gap-2">
                  <span className="flex min-w-0 flex-auto flex-col">
                    <span className="font-mono text-xs whitespace-nowrap text-ink-3">{speaker.label}</span>
                    <span className={cn("truncate font-semibold", (!speaker.displayName || speaker.needsConfirm) && "text-blue")}>
                      {speaker.displayName ? (
                        <>
                          {speaker.displayName}
                          {speaker.needsConfirm && "?"}
                        </>
                      ) : (
                        t("who")
                      )}
                    </span>
                  </span>
                  <span className="flex flex-none gap-1">
                    {speaker.displayName && speaker.needsConfirm && (
                      <Button
                        icon={<IconCheck size={16} />}
                        onClick={() =>
                          onAssign(speaker, {
                            personId: people.find((p) => p.name === speaker.displayName)?.id ?? null,
                            displayName: speaker.displayName!,
                          })
                        }
                      >
                        {t("correct")}
                      </Button>
                    )}
                    {speaker.displayName ? (
                      <Button variant="ghost" iconOnly icon={<IconPencil size={16} />} onClick={toggle} aria-expanded={open}>
                        {t("rename", { label: speaker.label })}
                      </Button>
                    ) : (
                      <Button onClick={toggle} aria-expanded={open} aria-label={open ? t("closePicker", { label: speaker.label }) : t("pickFor", { label: speaker.label })}>
                        {open ? t("close") : t("pick")}
                      </Button>
                    )}
                  </span>
                </div>
                {open && (
                  <SpeakerPicker
                    speaker={speaker}
                    people={people}
                    onPick={(choice) => {
                      onAssign(speaker, choice);
                      setEditing(null);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SpeakerPicker({
  speaker,
  people,
  onPick,
}: {
  speaker: Speaker;
  people: PersonOption[];
  onPick: (choice: SpeakerChoice) => void;
}) {
  const t = useTranslations("live.speakers");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  return (
    <div className="flex flex-col gap-2 pt-2" role="group" aria-label={t("pickFor", { label: speaker.label })}>
      <div className="flex flex-wrap gap-2">
        {people.map((person) => (
          <button
            key={person.id}
            type="button"
            className={cn("inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-md border border-control bg-surface px-4 text-sm font-medium text-ink transition-colors duration-120 hover:border-ink-3 hover:bg-sunk", person.name === speaker.displayName && "border-ink bg-ink text-on-ink hover:border-ink hover:bg-ink")}
            aria-pressed={person.name === speaker.displayName}
            onClick={() => onPick({ personId: person.id, displayName: person.name })}
          >
            {person.name}
          </button>
        ))}
        {!adding && (
          <button type="button" className={cn("inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-md border border-control bg-surface px-4 text-sm font-medium text-ink transition-colors duration-120 hover:border-ink-3 hover:bg-sunk", "border-dashed text-ink-2")} onClick={() => setAdding(true)}>
            <IconPlus size={14} /> {t("someoneElse")}
          </button>
        )}
      </div>
      {adding && (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const clean = name.trim();
            if (clean) onPick({ personId: null, displayName: clean });
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Label className="sr-only" htmlFor={`new-${speaker.elSessionId}-${speaker.speakerLabel}`}>
              {t("name")}
            </Label>
            <Input
              id={`new-${speaker.elSessionId}-${speaker.speakerLabel}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("name")}
              maxLength={100}
              autoFocus
              autoComplete="off"
            />
          </div>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {t("save")}
          </Button>
        </form>
      )}
    </div>
  );
}
