"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
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
  const [editing, setEditing] = useState<string | null>(null);
  const unknown = speakers.filter((s) => !s.displayName || s.needsConfirm).length;

  return (
    <section className="speakers" aria-labelledby="speakers-title">
      <div className="speakers__head">
        <h2 id="speakers-title" className="panel__title">
          Talare
        </h2>
        {unknown > 0 && (
          <span className="badge badge--info">
            {unknown} att bekräfta
          </span>
        )}
      </div>
      {speakers.length === 0 ? (
        <p className="subtle speakers__empty">Talarna dyker upp här när de börjar prata.</p>
      ) : (
        <ul className="speakers__list">
          {speakers.map((speaker) => {
            const key = speakerKeyString(speaker);
            const open = editing === key;
            const toggle = () => setEditing(open ? null : key);
            return (
              <li
                key={key}
                className={`speaker${!speaker.displayName ? " speaker--unknown" : ""}${speaker.needsConfirm ? " speaker--unsure" : ""}`}
              >
                <div className="speaker__row">
                  <span className="speaker__who">
                    <span className="speaker__label">{speaker.label}</span>
                    <span className="speaker__name">
                      {speaker.displayName ? (
                        <>
                          {speaker.displayName}
                          {speaker.needsConfirm && "?"}
                        </>
                      ) : (
                        "Vem är detta?"
                      )}
                    </span>
                  </span>
                  <span className="speaker__actions">
                    {speaker.displayName && speaker.needsConfirm && (
                      <Button
                        icon={<IconCheck size={16} />}
                        className="speaker__confirm"
                        onClick={() =>
                          onAssign(speaker, {
                            personId: people.find((p) => p.name === speaker.displayName)?.id ?? null,
                            displayName: speaker.displayName!,
                          })
                        }
                      >
                        Stämmer
                      </Button>
                    )}
                    {speaker.displayName ? (
                      <Button variant="ghost" iconOnly icon={<IconPencil size={16} />} onClick={toggle} aria-expanded={open}>
                        {`Byt namn på ${speaker.label}`}
                      </Button>
                    ) : (
                      <Button onClick={toggle} aria-expanded={open} aria-label={open ? `Stäng namnvalet för ${speaker.label}` : `Välj namn för ${speaker.label}`}>
                        {open ? "Stäng" : "Välj"}
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
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  return (
    <div className="picker" role="group" aria-label={`Välj namn för ${speaker.label}`}>
      <div className="picker__chips">
        {people.map((person) => (
          <button
            key={person.id}
            type="button"
            className={`chip${person.name === speaker.displayName ? " chip--current" : ""}`}
            aria-pressed={person.name === speaker.displayName}
            onClick={() => onPick({ personId: person.id, displayName: person.name })}
          >
            {person.name}
          </button>
        ))}
        {!adding && (
          <button type="button" className="chip chip--add" onClick={() => setAdding(true)}>
            <IconPlus size={14} /> Någon annan
          </button>
        )}
      </div>
      {adding && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const clean = name.trim();
            if (clean) onPick({ personId: null, displayName: clean });
          }}
        >
          <div className="field">
            <label className="visually-hidden" htmlFor={`new-${speaker.elSessionId}-${speaker.speakerLabel}`}>
              Namn
            </label>
            <input
              id={`new-${speaker.elSessionId}-${speaker.speakerLabel}`}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Namn"
              maxLength={100}
              autoFocus
              autoComplete="off"
            />
          </div>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Spara
          </Button>
        </form>
      )}
    </div>
  );
}
