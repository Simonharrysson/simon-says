"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink, Spinner } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Check, Field, hintClass } from "@/components/ui/Field";
import { IconCheck, IconChevronDown, IconFolder, IconLink, IconPencil, IconPlus, IconTrash, IconX } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STEPS, type StepId } from "@/lib/onboarding/steps";
import { LOGO_TYPES } from "@/lib/orgs/logo";
import { formatDateTime } from "@/lib/format";
import type { InviteRow } from "@/lib/invites/rules";
import type { BoardRow } from "@/lib/people/board";
import { cn } from "@/lib/utils";
import { OrgLogo } from "./OrgLogo";
import { OrgProfileFields } from "@/components/views/OrgProfileForm";
import type { ProfileErrors, ProfileField, ProfileInput } from "@/lib/orgs/profile";

// Kom igång's six steps and the end, presentational (no fetching): the container
// (Onboarding.tsx) and the /design gallery give them data and callbacks.


/** A quiet sentence under an action: what happened (polite live region). */
function Note({ children, tone = "neutral" }: { children?: ReactNode; tone?: "neutral" | "danger" | "success" }) {
  return (
    <p className={cn("min-h-5 text-sm", tone === "danger" ? "text-red" : tone === "success" ? "text-green" : "text-ink-3")} aria-live="polite">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// 1. Namn och logga

export interface LogoStepProps {
  orgName: string;
  logoUrl: string | null;
  busy?: boolean;
  message?: { text: string; tone: "neutral" | "danger" | "success" } | null;
  onFile: (file: File) => void;
  onRemove: () => void;
  name: string;
  onName: (name: string) => void;
  nameError?: string;
  /** "Om oss" and links (todo #13, optional): shown behind a quiet disclosure until opened or set. */
  profile?: ProfileInput;
  onProfile?: (field: keyof ProfileInput, text: string) => void;
  profileErrors?: ProfileErrors;
  /** Inställningar → Föreningen: Om oss and the links always shown (no disclosure). */
  profileOpen?: boolean;
  /** Företag: the name has its own form, so no name field here. */
  hideName?: boolean;
  /** Företag: its own hint under the logo, and only some of the profile fields with their own legend. */
  logoHint?: string;
  profileFields?: ProfileField[];
  profileLegend?: string;
  profileIntro?: string;
}

export function LogoStep(p: LogoStepProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const t = useTranslations("onboarding.logo");
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) p.onFile(file);
  };
  return (
    <div className="flex flex-col gap-8">
      {!p.hideName && (
        <Field
          id={`${id}-name`}
          label={t("orgName")}
          value={p.name}
          maxLength={100}
          autoComplete="organization"
          onChange={(e) => p.onName(e.target.value)}
          error={p.nameError}
        />
      )}
      <div className="flex flex-col gap-3">
        <span className="text-sm font-medium">{t("label")}</span>
        <div className="flex items-center gap-6 max-[30rem]:flex-col max-[30rem]:items-start">
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
            disabled={p.busy}
            aria-describedby={`${id}-hint`}
            className={cn(
              "group relative grid size-32 flex-none cursor-pointer place-items-center rounded-lg transition-[box-shadow,transform] duration-200 ease-out",
              p.logoUrl ? "shadow-panel" : "border border-dashed border-rail bg-surface hover:border-control",
              over && "scale-[1.02] border-blue shadow-[0_0_0_3px_var(--blue-wash)]",
            )}
          >
            {p.logoUrl ? (
              <OrgLogo name={p.orgName} src={p.logoUrl} size="lg" className="size-32 rounded-lg" />
            ) : (
              <span className="flex flex-col items-center gap-2 px-3 text-center text-xs text-ink-3">
                <OrgLogo name={p.orgName} size="md" className="opacity-90" />
                {t("drop")}
              </span>
            )}
            {p.busy && (
              <span className="absolute inset-0 grid place-items-center rounded-lg bg-surface/80">
                <Spinner className="text-xl text-ink-2" />
              </span>
            )}
            <span className="sr-only">{p.logoUrl ? t("change") : t("upload")}</span>
          </button>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => input.current?.click()} loading={p.busy}>
                {p.logoUrl ? t("changeImage") : t("upload")}
              </Button>
              {p.logoUrl && !p.busy && (
                <Button variant="ghost" onClick={p.onRemove}>
                  {t("remove")}
                </Button>
              )}
            </div>
            <p id={`${id}-hint`} className={cn(hintClass, "max-w-[22rem]")}>
              {p.logoHint ?? t("hint")}
            </p>
          </div>
        </div>
        <input
          ref={input}
          type="file"
          accept={LOGO_TYPES.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) p.onFile(file);
          }}
        />
        <Note tone={p.message?.tone}>{p.message?.text}</Note>
      </div>
      {p.profile && p.onProfile && (
        <ProfileSection
          value={p.profile}
          onChange={p.onProfile}
          errors={p.profileErrors}
          alwaysOpen={p.profileOpen}
          fields={p.profileFields}
          legend={p.profileLegend}
          intro={p.profileIntro}
        />
      )}
    </div>
  );
}

function ProfileSection({
  value,
  onChange,
  errors,
  alwaysOpen,
  fields,
  legend,
  intro,
}: {
  value: ProfileInput;
  onChange: (field: keyof ProfileInput, text: string) => void;
  errors?: ProfileErrors;
  alwaysOpen?: boolean;
  fields?: ProfileField[];
  legend?: string;
  intro?: string;
}) {
  const pt = useTranslations("profile");
  const id = useId();
  if (alwaysOpen) {
    return (
      <fieldset className="flex flex-col gap-4 border-t border-line pt-6">
        <legend className="float-left mb-1 font-medium">{legend ?? pt("legend")}</legend>
        <p className={cn(hintClass, "clear-left -mt-2 max-w-[40rem]")}>{intro ?? pt("intro")}</p>
        <OrgProfileFields value={value} onChange={onChange} errors={errors} fields={fields} />
      </fieldset>
    );
  }
  return <ProfileDisclosure value={value} onChange={onChange} errors={errors} id={id} />;
}

function ProfileDisclosure({ value, onChange, errors, id }: { value: ProfileInput; onChange: (field: keyof ProfileInput, text: string) => void; errors?: ProfileErrors; id: string }) {
  const pt = useTranslations("profile");
  const [open, setOpen] = useState(() => Object.values(value).some((v) => v.trim()) || Boolean(errors && Object.values(errors).some(Boolean)));
  const shown = open || Boolean(errors && Object.values(errors).some(Boolean));
  return (
    <div className="flex flex-col gap-4 border-t border-line pt-6">
      <button
        type="button"
        className="-mx-2 inline-flex min-h-10 items-center gap-2 self-start rounded-md px-2 text-sm font-medium text-ink hover:bg-sunk max-md:min-h-11"
        aria-expanded={shown}
        aria-controls={`${id}-profile`}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevronDown size={16} className={cn("transition-transform duration-200 ease-out", !shown && "-rotate-90")} />
        {pt("onboardingToggle")}
      </button>
      <div id={`${id}-profile`} hidden={!shown}>
        <p className={cn(hintClass, "mb-4 max-w-[40rem]")}>{pt("onboardingHint")}</p>
        <OrgProfileFields value={value} onChange={onChange} errors={errors} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Styrelsen

export interface BoardInput {
  name: string;
  role: string;
  email: string;
}

export type FormError = string | { message: string; editPersonId?: string } | null;
const errText = (e: FormError) => (e === null ? null : typeof e === "string" ? e : e.message);

export interface BoardStepProps {
  orgName: string;
  rows: BoardRow[];
  inviteUrl: string;
  /** Each returns an error sentence, or null when it worked. */
  /** An error sentence; `editPersonId` when the name is already on the list (offer to edit it). */
  onAdd: (input: BoardInput, memberUserId?: string) => Promise<FormError>;
  onUpdate: (personId: string, input: BoardInput) => Promise<string | null>;
  onRemove: (personId: string) => Promise<string | null>;
  /** The signed-in admin's own e-mail, to say "du" on their row. */
  myEmail?: string | null;
  /** Invites sent by e-mail (0038): each invited person's row says how theirs went. */
  invites?: InviteRow[];
  /** "Bjud in via mejl" (`InviteByEmail`), under the list when someone has an e-mail. */
  inviteEmail?: ReactNode;
  /**
   * The förening page's Inställningar (one board list): per member user id, the account controls
   * (make/remove admin, step down, remove from the förening, leave). A row with an account then
   * also offers those (the trash still deletes only the name and role, after a confirm).
   */
  memberControls?: Record<string, ReactNode>;
  /** Under "Dela länk": e.g. Inställningar's "Skapa ny länk". */
  linkActions?: ReactNode;
  /** Sends the invite e-mail to a person's address from their row; an error sentence, or null. */
  onInvite?: (email: string) => Promise<string | null>;
  /** "Det stämmer inte" on a "Nyss kopplad" row (0051): unlinks a member's self link. */
  onUndoSelfLink?: (personId: string) => Promise<string | null>;
}

export function BoardStep(p: BoardStepProps) {
  const id = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const t = useTranslations("onboarding.board");
  return (
    <div className="flex flex-col gap-6">
      <datalist id={`${id}-roles`}>
        {(t.raw("roles") as string[]).map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      {p.rows.length === 0 ? (
        <EmptyState title={t("emptyTitle")}>
          <p>{t("emptyText")}</p>
        </EmptyState>
      ) : (
        <ul className="flex flex-col rounded-lg bg-surface shadow-panel in-card:-mx-4 in-card:bg-transparent in-card:shadow-none" aria-label={t("listLabel")}>
          {p.rows.map((row) => {
            const key = row.personId ?? `m:${row.member?.userId}`;
            return (
              <li key={key} className="border-t border-line first:border-t-0">
                {editing === key ? (
                  <PersonForm
                    uid={`${id}-${key}`}
                    rolesList={`${id}-roles`}
                    initial={{ name: row.name ?? "", role: row.role ?? "", email: row.personId ? (row.email ?? "") : "" }}
                    emailLocked={!row.personId}
                    submitLabel={row.personId ? t("save") : t("add")}
                    onCancel={() => setEditing(null)}
                    onSubmit={async (input) => {
                      const err = row.personId ? await p.onUpdate(row.personId, input) : await p.onAdd(input, row.member?.userId);
                      if (!err) setEditing(null);
                      return err;
                    }}
                    onEditExisting={setEditing}
                  />
                ) : (
                  <BoardRowView
                    row={row}
                    invite={p.invites?.find((i) => i.email === row.email?.toLowerCase())}
                    me={Boolean(p.myEmail && (row.member?.email ?? "").toLowerCase() === p.myEmail)}
                    onEdit={() => setEditing(key)}
                    onRemove={row.personId ? () => p.onRemove(row.personId!) : undefined}
                    controls={row.member ? p.memberControls?.[row.member.userId] : undefined}
                    onInvite={p.onInvite}
                    onUndoSelfLink={row.personId && row.selfLinkedAt && p.onUndoSelfLink ? () => p.onUndoSelfLink!(row.personId!) : undefined}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-3 rounded-lg border border-dashed border-rail p-4 in-card:border-0 in-card:bg-sunk/60">
        <span className="text-sm font-medium">{t("addSomeone")}</span>
        <PersonForm uid={`${id}-new`} rolesList={`${id}-roles`} initial={{ name: "", role: "", email: "" }} submitLabel={t("add")} onSubmit={(input) => p.onAdd(input)} onEditExisting={setEditing} resetOnSuccess />
      </div>

      <InviteArea inviteUrl={p.inviteUrl} inviteEmail={p.inviteEmail} linkActions={p.linkActions} />
    </div>
  );
}

/**
 * Under the board list: the other two ways in, folded so the list stays the one place. "Bjud in
 * via mejl" (several addresses at once, the e-mail's preview, every invite sent) and "Dela länk"
 * (the invite link to pass on). Someone on the list gets theirs from their own row.
 */
function InviteArea({ inviteUrl, inviteEmail, linkActions }: { inviteUrl: string; inviteEmail?: ReactNode; linkActions?: ReactNode }) {
  const t = useTranslations("onboarding.board");
  const id = useId();
  const [mail, setMail] = useState(false);
  const [link, setLink] = useState(false);
  const mailShown = mail;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {inviteEmail && (
          <Button variant="secondary" size="sm" icon={<IconChevronDown size={16} className={cn("transition-transform duration-200 ease-out", !mailShown && "-rotate-90")} />} aria-expanded={mailShown} aria-controls={`${id}-mail`} onClick={() => setMail(!mailShown)}>
            {t("inviteByEmail")}
          </Button>
        )}
        <Button variant="ghost" size="sm" icon={<IconLink size={16} />} aria-expanded={link} aria-controls={`${id}-link`} onClick={() => setLink(!link)}>
          {t("shareLink")}
        </Button>
      </div>
      {inviteEmail && mailShown && (
        <section id={`${id}-mail`} aria-labelledby={`${id}-mail-h`} className="flex flex-col gap-3 rounded-lg bg-surface p-4 shadow-panel animate-notice-in in-card:bg-sunk/60 in-card:shadow-none">
          <h3 id={`${id}-mail-h`} className="text-sm font-semibold">
            {t("inviteByEmail")}
          </h3>
          <p className="text-sm text-ink-2">{t("inviteText")}</p>
          {inviteEmail}
        </section>
      )}
      {link && (
        <div id={`${id}-link`} className="flex flex-col gap-3 rounded-lg bg-surface p-4 shadow-panel animate-notice-in in-card:bg-sunk/60 in-card:shadow-none">
          <p className="text-sm text-ink-2">{t("shareText")}</p>
          <CopyField id={`${id}-invite`} value={inviteUrl} label={t("inviteLink")} />
          {linkActions && <div>{linkActions}</div>}
        </div>
      )}
    </div>
  );
}

function StatusLine({ row, me, invite }: { row: BoardRow; me: boolean; invite?: InviteRow }): ReactNode {
  const t = useTranslations("onboarding.board");
  const statuses = useTranslations("invites.status");
  const locale = useLocale();
  if (row.status === "account") {
    return (
      <>
        <span className="text-green">{t("hasAccount")}</span>
        {row.member?.email && <span className="wrap-anywhere"> · {row.member.email}</span>}
        {me && t("you")}
        {row.member?.role === "admin" && t("admin")}
      </>
    );
  }
  if (row.status === "invited") {
    const sent = invite?.lastSentAt ?? invite?.acceptedAt;
    return (
      <span className="wrap-anywhere">
        {row.email}
        {invite
          ? `${t("invite", { status: statuses(invite.status).toLowerCase() })}${sent ? ` ${formatDateTime(sent, locale)}` : ""}`
          : t("noInvite")}
      </span>
    );
  }
  return t("nameOnly");
}

function BoardRowView({
  row,
  me,
  invite,
  onEdit,
  onRemove,
  controls,
  onInvite,
  onUndoSelfLink,
}: {
  row: BoardRow;
  me: boolean;
  invite?: InviteRow;
  onEdit: () => void;
  onRemove?: () => Promise<string | null>;
  onInvite?: (email: string) => Promise<string | null>;
  /** Account controls (the förening page's Inställningar), under the status line. */
  controls?: ReactNode;
  onUndoSelfLink?: () => Promise<string | null>;
}) {
  const t = useTranslations("onboarding.board");
  const orgT = useTranslations("org");
  const [removing, setRemoving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locale = useLocale();
  const display = row.name ?? row.email ?? t("unknown");
  const canInvite = Boolean(onInvite && row.status === "invited" && row.email && !invite);
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <div className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3">
        <span className="mt-0.5 grid size-9 flex-none place-items-center rounded-full bg-sunk text-sm font-medium text-ink-2" aria-hidden="true">
          {(row.name ?? "?").trim().charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="font-medium wrap-anywhere">
            {row.name ?? <span className="text-ink-3">{t("noName")}</span>}
            {row.role && <span className="font-normal text-ink-2"> · {row.role}</span>}
          </span>
          <span className="text-sm text-ink-3">
            <StatusLine row={row} me={me} invite={invite} />
          </span>
          {row.selfLinkedAt && onUndoSelfLink && (
            <span className="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
              <span className="text-ink-2">{t("selfLinked", { when: formatDateTime(row.selfLinkedAt, locale) })}</span>
              <Button
                variant="ghost"
                size="sm"
                loading={undoing}
                aria-label={t("undoSelfLinkLabel", { name: display })}
                onClick={async () => {
                  setUndoing(true);
                  setError(await onUndoSelfLink());
                  setUndoing(false);
                }}
              >
                {t("undoSelfLink")}
              </Button>
            </span>
          )}
          {canInvite && (
            <span className="mt-2">
              <Button
                variant="secondary"
                size="sm"
                loading={inviting}
                onClick={async () => {
                  setInviting(true);
                  setError(await onInvite!(row.email!));
                  setInviting(false);
                }}
              >
                {t("sendInvite")}
              </Button>
            </span>
          )}
          {controls && <span className="mt-1 -ml-3 flex flex-wrap items-center gap-1">{controls}</span>}
          {!row.personId && (
            <span className="mt-2">
              <Button variant="secondary" size="sm" icon={<IconPlus size={16} />} onClick={onEdit}>
                {t("addName")}
              </Button>
            </span>
          )}
        </span>
        <span className="flex items-center gap-1">
          {row.personId && (
            <Button variant="ghost" size="sm" icon={<IconPencil size={16} />} iconOnly onClick={onEdit}>
              {t("edit", { name: display })}
            </Button>
          )}
          {onRemove && controls ? (
            // A row with an account (the förening page): deletes the name and role only, asked
            // first as the people list did; the account goes with "Ta bort" among the controls.
            <ConfirmAction
              action={async () => {
                setError(await onRemove());
              }}
              hidden={{}}
              trigger={t("remove", { name: display })}
              triggerIcon={<IconTrash size={16} />}
              triggerIconOnly
              triggerVariant="danger-ghost"
              title={orgT("removePersonTitle", { name: display })}
              description={orgT("removePersonText")}
              confirmLabel={orgT("remove")}
              pendingLabel={orgT("removing")}
            />
          ) : onRemove && (
            <Button
              variant="danger-ghost"
              size="sm"
              iconOnly
              icon={<IconTrash size={16} />}
              loading={removing}
              onClick={async () => {
                setRemoving(true);
                setError(await onRemove());
                setRemoving(false);
              }}
            >
              {t("remove", { name: display })}
            </Button>
          )}
        </span>
      </div>
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}

function PersonForm({
  uid,
  rolesList,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  resetOnSuccess,
  emailLocked,
  onEditExisting,
}: {
  uid: string;
  rolesList: string;
  initial: BoardInput;
  submitLabel: string;
  onSubmit: (input: BoardInput) => Promise<FormError>;
  /** Opens the existing person's row (a duplicate name). */
  onEditExisting?: (personId: string) => void;
  onCancel?: () => void;
  resetOnSuccess?: boolean;
  emailLocked?: boolean;
}) {
  const t = useTranslations("onboarding.board");
  const common = useTranslations("common");
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const existing = error && typeof error === "object" ? error.editPersonId : undefined;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!v.name.trim()) {
      setError(t("nameRequired"));
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    const err = await onSubmit(v);
    setBusy(false);
    setError(err);
    if (!err && resetOnSuccess) {
      setV({ name: "", role: "", email: "" });
      nameRef.current?.focus();
    }
  };
  return (
    <form onSubmit={submit} className={cn("flex flex-col gap-3", onCancel && "bg-board px-4 py-4")} noValidate>
      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-3 max-[36rem]:grid-cols-1">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-name`}>{t("name")}</Label>
          <Input ref={nameRef} id={`${uid}-name`} value={v.name} maxLength={100} placeholder={t("namePlaceholder")} autoComplete="off" onChange={(e) => setV({ ...v, name: e.target.value })} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-role`}>{t("role")}</Label>
          <Input id={`${uid}-role`} value={v.role} maxLength={40} placeholder={t("rolePlaceholder")} list={rolesList} autoComplete="off" onChange={(e) => setV({ ...v, role: e.target.value })} />
        </div>
      </div>
      {!emailLocked && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-email`}>
            {t("email")} <span className="font-normal text-ink-3">{t("emailOptional")}</span>
          </Label>
          <Input id={`${uid}-email`} type="email" inputMode="email" value={v.email} maxLength={254} placeholder="anna@example.com" autoComplete="off" onChange={(e) => setV({ ...v, email: e.target.value })} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant={onCancel ? "primary" : "secondary"} icon={onCancel ? <IconCheck size={18} /> : <IconPlus size={18} />} loading={busy}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" icon={<IconX size={18} />} onClick={onCancel} disabled={busy}>
            {common("cancel")}
          </Button>
        )}
      </div>
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <Note tone="danger">{errText(error)}</Note>
          {existing && onEditExisting && (
            <Button variant="secondary" size="sm" icon={<IconPencil size={16} />} onClick={() => onEditExisting(existing)}>
              {t("editExisting", { name: v.name.trim() })}
            </Button>
          )}
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Mötesmapp

export interface FolderStepProps {
  folderName: string | null;
  folderSet: boolean;
  pickerEnabled: boolean;
  busy?: boolean;
  message?: string | null;
  onPick: () => void;
}

export function FolderStep(p: FolderStepProps) {
  const t = useTranslations("onboarding.folder");
  return (
    <div className="flex flex-col gap-6">
      {p.folderSet ? (
        <div className="flex items-center gap-4 rounded-lg bg-surface p-4 shadow-panel in-card:bg-sunk/60 in-card:shadow-none">
          <span className="grid size-11 flex-none place-items-center rounded-md bg-sunk text-ink-2 in-card:bg-surface">
            <IconFolder size={22} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium wrap-anywhere">{p.folderName ?? t("fallbackName")}</span>
            <span className="text-sm text-green">{t("chosen")}</span>
          </span>
          {p.pickerEnabled && (
            <Button variant="ghost" size="sm" onClick={p.onPick} loading={p.busy}>
              {t("change")}
            </Button>
          )}
        </div>
      ) : (
        <EmptyState
          title={t("noneTitle")}
          action={
            p.pickerEnabled ? (
              <Button variant="secondary" icon={<IconFolder size={18} />} onClick={p.onPick} loading={p.busy}>
                {t("pick")}
              </Button>
            ) : undefined
          }
        >
          <p>{t("noneText")}</p>
        </EmptyState>
      )}
      {!p.pickerEnabled && (
        <Banner tone="neutral" live={false}>
          {t("pickerOff")}
        </Banner>
      )}
      <Note>{p.message}</Note>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 5. Era tidigare möten

export function HistoryStep({ importHref, historyCount, onOpen }: { importHref: string; historyCount: number; onOpen?: () => void }) {
  const t = useTranslations("onboarding.history");
  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-col gap-4 text-sm text-ink-2">
        {[
          [t("pick"), t("pickText")],
          [t("cost"), t("costText")],
          [t("order"), t("orderText")],
        ].map(([title, d], i) => (
          <li key={title} className="flex gap-4">
            <span className="grid size-7 flex-none place-items-center rounded-full bg-sunk font-mono text-xs text-ink-2" aria-hidden="true">
              {i + 1}
            </span>
            <span className="flex flex-col gap-0.5 pt-0.5">
              <span className="font-medium text-ink">{title}</span>
              {d}
            </span>
          </li>
        ))}
      </ol>
      {historyCount > 0 && (
        <p className="flex items-center gap-2 text-sm text-green">
          <IconCheck size={18} /> {t("soFar", { count: historyCount })}
        </p>
      )}
      <div className="flex flex-col items-start gap-2">
        <ButtonLink href={importHref} variant="secondary" onClick={onOpen}>
          {historyCount > 0 ? t("more") : t("choose")}
        </ButtonLink>
        <p className={hintClass}>{t("hint")}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 6. Röster (valfritt)

export interface VoicesStepProps {
  people: { personId: string; name: string; role: string | null; consent: boolean }[];
  onConsent: (personId: string, consent: boolean) => void;
  pending?: string | null;
  error?: string | null;
  onBoard: () => void;
}

export function VoicesStep(p: VoicesStepProps) {
  const t = useTranslations("onboarding.voices");
  const id = useId();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-lg bg-surface p-5 shadow-panel in-card:bg-sunk/60 in-card:shadow-none">
        <p className="font-medium">{t("soon")}</p>
        <p className="text-sm text-ink-2">{t("idea")}</p>
        <p className="text-sm text-ink-3">{t("notYet")}</p>
      </div>
      {p.people.length === 0 ? (
        <EmptyState title={t("noBoardTitle")} action={<Button variant="secondary" onClick={p.onBoard}>{t("addBoard")}</Button>}>
          <p>{t("noBoardText")}</p>
        </EmptyState>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-3 text-sm font-medium">{t("legend")}</legend>
          <ul className="flex flex-col rounded-lg bg-surface shadow-panel in-card:-mx-4 in-card:bg-transparent in-card:shadow-none">
            {p.people.map((person) => (
              <li key={person.personId} className="border-t border-line px-4 py-3 first:border-t-0">
                <Check
                  id={`${id}-${person.personId}`}
                  title={
                    <>
                      {person.name}
                      {person.role && <span className="font-normal text-ink-3"> · {person.role}</span>}
                    </>
                  }
                  checked={person.consent}
                  disabled={p.pending === person.personId}
                  onCheckedChange={(v) => p.onConsent(person.personId, v === true)}
                >
                  {person.consent ? t("saidYes") : undefined}
                </Check>
              </li>
            ))}
          </ul>
          <p className={cn(hintClass, "mt-2")}>{t("askEach")}</p>
          <Note tone="danger">{p.error}</Note>
        </fieldset>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Klart

export function DoneStep({
  done,
  skipped,
  prepareHref,
  orgHref,
  onGo,
  editHref,
}: {
  done: StepId[];
  skipped: StepId[];
  prepareHref: string;
  orgHref: string;
  onGo?: (s: StepId) => void;
  /** Where a done step's setting lives now (Inställningar's section): "Ändra" links there. */
  editHref?: (s: StepId) => string;
}) {
  const t = useTranslations("onboarding");
  return (
    <div className="flex flex-col gap-8">
      <ul className="flex flex-col rounded-lg bg-surface shadow-panel">
        {STEPS.map((s) => {
          const isDone = done.includes(s.id);
          return (
            <li key={s.id} className="flex min-h-12 items-center gap-3 border-t border-line px-4 py-2 first:border-t-0">
              <span className={cn("grid size-6 flex-none place-items-center", isDone ? "text-green" : "text-ink-3")} aria-hidden="true">
                {isDone ? <IconCheck size={18} /> : "–"}
              </span>
              <span className="flex-1">
                {t(`steps.${s.id}.title`)}
                <span className="sr-only">{isDone ? t("done.isDone") : t("done.isSkipped")}</span>
              </span>
              {!isDone && onGo && (
                <Button variant="ghost" size="sm" onClick={() => onGo(s.id)}>
                  {skipped.includes(s.id) ? t("done.doNow") : t("done.open")}
                </Button>
              )}
              {isDone && editHref && (
                <ButtonLink href={editHref(s.id)} variant="ghost" size="sm">
                  {t("done.change")}
                  <span className="sr-only">: {t(`steps.${s.id}.title`)}</span>
                </ButtonLink>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3 max-[30rem]:flex-col max-[30rem]:items-stretch">
        <ButtonLink href={prepareHref} variant="primary" size="lg">
          {t("done.prepare")}
        </ButtonLink>
        <ButtonLink href={orgHref} variant="ghost" size="lg">
          {t("done.toOrg")}
        </ButtonLink>
      </div>
    </div>
  );
}
