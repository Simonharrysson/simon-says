"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { IconPencil, IconTrash } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";

/** One person in the org's list: read mode with rename/delete, or an inline rename form. */
export function PersonRow({
  orgId,
  person,
  renamePerson,
  setPersonRole,
  deletePerson,
}: {
  orgId: string;
  person: { id: string; name: string; role?: string | null };
  renamePerson: FormAction;
  /** Only passed for admins: roles are set by the admin. */
  setPersonRole?: FormAction;
  deletePerson: FormAction;
}) {
  const [editing, setEditing] = useState(false);
  const [editingRole, setEditingRole] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
    else if (wasEditing.current) editRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  if (editingRole && setPersonRole) {
    return (
      <li>
        <form
          className="row person-edit"
          action={async (form) => {
            await setPersonRole(form);
            setEditingRole(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditingRole(false);
          }}
        >
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="personId" value={person.id} />
          <label className="visually-hidden" htmlFor={`role-${person.id}`}>
            Roll för {person.name}
          </label>
          <input
            id={`role-${person.id}`}
            className="input"
            name="role"
            defaultValue={person.role ?? ""}
            placeholder="Roll (t.ex. Kassör)"
            maxLength={40}
            autoComplete="off"
            autoFocus
          />
          <span className="row__actions">
            <SubmitButton variant="primary" size="sm" pendingLabel="Sparar…">
              Spara
            </SubmitButton>
            <Button variant="ghost" size="sm" onClick={() => setEditingRole(false)}>
              Avbryt
            </Button>
          </span>
        </form>
      </li>
    );
  }

  if (editing) {
    return (
      <li>
        <form
          className="row person-edit"
          action={async (form) => {
            await renamePerson(form);
            setEditing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
          }}
        >
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="personId" value={person.id} />
          <label className="visually-hidden" htmlFor={`person-${person.id}`}>
            Nytt namn för {person.name}
          </label>
          <input
            ref={inputRef}
            id={`person-${person.id}`}
            className="input"
            name="name"
            defaultValue={person.name}
            required
            maxLength={100}
            autoComplete="off"
          />
          <span className="row__actions">
            <SubmitButton variant="primary" size="sm" pendingLabel="Sparar…">
              Spara
            </SubmitButton>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Avbryt
            </Button>
          </span>
        </form>
      </li>
    );
  }

  return (
    <li>
      <div className="row">
        <span className="person-avatar" aria-hidden="true">
          {initials(person.name)}
        </span>
        <span className="row__main">
          <span className="row__title">
            {person.name}
            {person.role && <span className="subtle"> · {person.role}</span>}
          </span>
        </span>
        <span className="row__actions">
          {setPersonRole && (
            <Button variant="ghost" size="sm" onClick={() => setEditingRole(true)}>
              {person.role ? "Ändra roll" : "Lägg till roll"}
            </Button>
          )}
          <button
            ref={editRef}
            type="button"
            className="btn btn--ghost btn--sm btn--icon"
            onClick={() => setEditing(true)}
            title="Byt namn"
          >
            <IconPencil size={18} />
            <span className="visually-hidden">Byt namn på {person.name}</span>
          </button>
          <ConfirmAction
            action={deletePerson}
            hidden={{ orgId, personId: person.id }}
            trigger={`Ta bort ${person.name}`}
            triggerIcon={<IconTrash size={18} />}
            triggerIconOnly
            triggerVariant="danger-ghost"
            title={`Ta bort ${person.name}?`}
            description="Namnet försvinner ur personlistan. Det som redan står i mötesdokumenten ändras inte."
            confirmLabel="Ta bort"
            pendingLabel="Tar bort…"
          />
        </span>
      </div>
    </li>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
