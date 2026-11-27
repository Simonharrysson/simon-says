"use client";

import { PresenceLi } from "@/components/motion/Presence";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { IconPencil, IconTrash } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";

/** One person in the org's list: read mode with rename/delete, or an inline rename form. */
export function PersonRow({
  orgId,
  person,
  status,
  renamePerson,
  setPersonRole,
  deletePerson,
}: {
  orgId: string;
  person: { id: string; name: string; role?: string | null };
  /** One grey line under the name: the account link ("Har konto · …", "Inbjuden · …"), 0035. */
  status?: string | null;
  renamePerson: FormAction;
  /** Only passed for admins: roles are set by the admin. */
  setPersonRole?: FormAction;
  deletePerson: FormAction;
}) {
  const t = useTranslations("org");
  const common = useTranslations("common");
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
      <PresenceLi>
        <form
          className="flex min-h-14 items-center gap-3 border-t border-line px-6 py-3 [li:first-child>&]:border-t-0 max-[30rem]:flex-wrap"
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
          <Label className="sr-only" htmlFor={`role-${person.id}`}>
            {t("roleFor", { name: person.name })}
          </Label>
          <Input
            id={`role-${person.id}`}
            className="min-w-0 flex-1"
            name="role"
            defaultValue={person.role ?? ""}
            placeholder={t("rolePlaceholder")}
            maxLength={40}
            autoComplete="off"
            autoFocus
          />
          <span className="flex flex-none items-center gap-1 max-[30rem]:w-full max-[30rem]:justify-end">
            <SubmitButton variant="primary" size="sm" pendingLabel={common("saving")}>
              {common("save")}
            </SubmitButton>
            <Button variant="ghost" size="sm" onClick={() => setEditingRole(false)}>
              {common("cancel")}
            </Button>
          </span>
        </form>
      </PresenceLi>
    );
  }

  if (editing) {
    return (
      <PresenceLi>
        <form
          className="flex min-h-14 items-center gap-3 border-t border-line px-6 py-3 [li:first-child>&]:border-t-0 max-[30rem]:flex-wrap"
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
          <Label className="sr-only" htmlFor={`person-${person.id}`}>
            {t("newNameFor", { name: person.name })}
          </Label>
          <Input
            ref={inputRef}
            id={`person-${person.id}`}
            className="min-w-0 flex-1"
            name="name"
            defaultValue={person.name}
            required
            maxLength={100}
            autoComplete="off"
          />
          <span className="flex flex-none items-center gap-1 max-[30rem]:w-full max-[30rem]:justify-end">
            <SubmitButton variant="primary" size="sm" pendingLabel={common("saving")}>
              {common("save")}
            </SubmitButton>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {common("cancel")}
            </Button>
          </span>
        </form>
      </PresenceLi>
    );
  }

  return (
    <PresenceLi>
      <div className="flex min-h-14 items-center gap-3 border-t border-line px-6 py-3 [li:first-child>&]:border-t-0">
        <span className="grid size-8 flex-none place-items-center rounded-full bg-sunk text-2xs font-semibold tracking-[0.02em] text-ink-2" aria-hidden="true">
          {initials(person.name)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[0.1rem]">
          <span className="font-medium wrap-anywhere">
            {person.name}
            {person.role && <span className="text-sm text-ink-3"> · {person.role}</span>}
          </span>
          {status && <span className="text-sm text-ink-3 wrap-anywhere">{status}</span>}
        </span>
        <span className="flex flex-none items-center gap-1">
          {setPersonRole && (
            <Button variant="ghost" size="sm" onClick={() => setEditingRole(true)}>
              {person.role ? t("changeRole") : t("addRole")}
            </Button>
          )}
          <button
            ref={editRef}
            type="button"
            className={buttonVariants({ variant: "ghost", size: "sm", iconOnly: true })}
            onClick={() => setEditing(true)}
            title={t("rename")}
>
            <IconPencil size={18} />
            <span className="sr-only">{t("renameFor", { name: person.name })}</span>
          </button>
          <ConfirmAction
            action={deletePerson}
            hidden={{ orgId, personId: person.id }}
            trigger={t("removePerson", { name: person.name })}
            triggerIcon={<IconTrash size={18} />}
            triggerIconOnly
            triggerVariant="danger-ghost"
            title={t("removePersonTitle", { name: person.name })}
            description={t("removePersonText")}
            confirmLabel={t("remove")}
            pendingLabel={t("removing")}
          />
        </span>
      </div>
    </PresenceLi>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length> 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
