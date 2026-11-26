"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink, Spinner } from "@/components/ui/button";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Check, Field, hintClass } from "@/components/ui/Field";
import { IconCheck, IconFolder, IconPencil, IconPlus, IconTrash, IconX } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STEPS, type StepId } from "@/lib/onboarding/steps";
import { LOGO_TYPES } from "@/lib/orgs/logo";
import { formatDateTime } from "@/lib/format";
import type { InviteRow } from "@/lib/invites/rules";
import type { BoardRow } from "@/lib/people/board";
import { cn } from "@/lib/utils";
import { StadgarArsmote, type StadgarPhase } from "@/components/views/StadgarArsmote";
import { OrgLogo } from "./OrgLogo";

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
      <Field
        id={`${id}-name`}
        label={t("orgName")}
        value={p.name}
        maxLength={100}
        autoComplete="organization"
        onChange={(e) => p.onName(e.target.value)}
        error={p.nameError}
      />
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
              {t("hint")}
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
}

export function BoardStep(p: BoardStepProps) {
  const id = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const t = useTranslations("onboarding.board");
  const invited = p.rows.filter((r) => r.status === "invited");
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
        <ul className="flex flex-col rounded-lg bg-surface shadow-panel" aria-label={t("listLabel")}>
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
                  <BoardRowView row={row} invite={p.invites?.find((i) => i.email === row.email?.toLowerCase())} me={Boolean(p.myEmail && (row.member?.email ?? "").toLowerCase() === p.myEmail)} onEdit={() => setEditing(key)} onRemove={row.personId ? () => p.onRemove(row.personId!) : undefined} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-3 rounded-lg border border-dashed border-rail p-4">
        <span className="text-sm font-medium">{t("addSomeone")}</span>
        <PersonForm uid={`${id}-new`} rolesList={`${id}-roles`} initial={{ name: "", role: "", email: "" }} submitLabel={t("add")} onSubmit={(input) => p.onAdd(input)} onEditExisting={setEditing} resetOnSuccess />
      </div>

      {invited.length > 0 && (
        <div className="flex flex-col gap-3">
          {p.inviteEmail ? (
            <>
              <span className="text-sm font-medium">{t("inviteByEmail")}</span>
              <p className="text-sm text-ink-2">{t("inviteText")}</p>
              {p.inviteEmail}
              <CopyField id={`${id}-invite`} value={p.inviteUrl} label={t("orShare")} />
            </>
          ) : (
            <>
              <p className="text-sm text-ink-2">{t("shareText")}</p>
              <CopyField id={`${id}-invite`} value={p.inviteUrl} label={t("inviteLink")} />
            </>
          )}
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

function BoardRowView({ row, me, invite, onEdit, onRemove }: { row: BoardRow; me: boolean; invite?: InviteRow; onEdit: () => void; onRemove?: () => Promise<string | null> }) {
  const t = useTranslations("onboarding.board");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const display = row.name ?? row.email ?? t("unknown");
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
          {onRemove && (
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
        <div className="flex items-center gap-4 rounded-lg bg-surface p-4 shadow-panel">
          <span className="grid size-11 flex-none place-items-center rounded-md bg-sunk text-ink-2">
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
// 4. Så brukar ni ha möten

export type WeeklyChoice = "veckomote" | "learn" | "current";

export type { StadgarPhase } from "@/components/views/StadgarArsmote";

export interface FormatStepProps {
  choice: WeeklyChoice;
  onChoice: (c: WeeklyChoice) => void;
  /** The förening's current default when it is not plain Veckomöte/Enkel (e.g. "Eget (2026-11-02)"). */
  currentName?: string | null;
  /** The "learn from old minutes" flow (FormatEditor's LearnFormatView), shown under its option. */
  learn?: ReactNode;
  pickerEnabled: boolean;
  stadgar: StadgarPhase;
  /** An årsmöte from the stadgar is already saved (an earlier visit). */
  stadgarSaved?: boolean;
  onStadgarPick: () => void;
  onStadgarChange: (arsmote: string[]) => void;
  onStadgarSave: () => void;
  onStadgarCancel: () => void;
}


export function FormatStep(p: FormatStepProps) {
  const t = useTranslations("onboarding.format");
  const stadgarCopy = useTranslations("stadgar");
  const id = useId();
  // The Veckomöte's items as they will stand in the (Swedish) Doc.
  const preview = t.raw("preview") as string[];
  const options: { value: WeeklyChoice; title: string; hint: ReactNode }[] = [
    ...(p.currentName ? [{ value: "current" as const, title: t("keep", { name: p.currentName }), hint: t("keepHint") }] : []),
    { value: "veckomote", title: t("weekly"), hint: t("weeklyHint", { items: preview.join(" · ") }) },
    { value: "learn", title: t("learn"), hint: t("learnHint") },
  ];
  return (
    <div className="flex flex-col gap-10">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-lg font-semibold">{t("legend")}</legend>
        {options.map((o) => {
          const checked = p.choice === o.value;
          return (
            <div key={o.value} className={cn("rounded-lg border bg-surface transition-colors duration-120", checked ? "border-ink" : "border-line hover:border-control")}>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 p-4">
                <input type="radio" name={`${id}-weekly`} value={o.value} checked={checked} onChange={() => p.onChoice(o.value)} className="mt-1 size-4 accent-[var(--ink)]" />
                <span className="flex flex-col gap-1">
                  <span className="font-medium">
                    {o.title}
                    {o.value === "veckomote" && !p.currentName && <span className="font-normal text-ink-3">{t("default")}</span>}
                  </span>
                  <span className={hintClass}>{o.hint}</span>
                </span>
              </label>
              {checked && o.value === "learn" && p.learn && <div className="border-t border-line px-4 py-4 animate-notice-in">{p.learn}</div>}
            </div>
          );
        })}
      </fieldset>

      <section className="flex flex-col gap-4" aria-labelledby={`${id}-stadgar`}>
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-stadgar`} className="text-lg">
            {t("statutes")} <span className="font-normal text-ink-3">{t("optional")}</span>
          </h2>
          <p className="max-w-[34rem] text-sm text-ink-2">
            {stadgarCopy("lead")} {stadgarCopy("edit")}
          </p>
        </div>
        <StadgarArsmote
          uid={`${id}-stadgar`}
          stadgar={p.stadgar}
          pickerEnabled={p.pickerEnabled}
          saved={p.stadgarSaved}
          onPick={p.onStadgarPick}
          onChange={p.onStadgarChange}
          onSave={p.onStadgarSave}
          onCancel={p.onStadgarCancel}
        />
      </section>
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
      <div className="flex flex-col gap-3 rounded-lg bg-surface p-5 shadow-panel">
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
          <ul className="flex flex-col rounded-lg bg-surface shadow-panel">
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

export function DoneStep({ done, skipped, prepareHref, orgHref, onGo }: { done: StepId[]; skipped: StepId[]; prepareHref: string; orgHref: string; onGo?: (s: StepId) => void }) {
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
