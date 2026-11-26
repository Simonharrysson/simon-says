"use client";

import { useId, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button, ButtonLink, Spinner } from "@/components/ui/button";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Check, Field, hintClass } from "@/components/ui/Field";
import { IconCheck, IconExternal, IconFolder, IconPencil, IconPlus, IconTrash, IconX } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { plural } from "@/lib/format";
import { STEPS, type StepId } from "@/lib/onboarding/steps";
import { LOGO_TYPES } from "@/lib/orgs/logo";
import { inviteMailto, type BoardRow } from "@/lib/people/board";
import { cn } from "@/lib/utils";
import { OrgLogo } from "./OrgLogo";

// Kom igång's six steps and the end, presentational (no fetching): the container
// (Onboarding.tsx) and the /design gallery give them data and callbacks.

const ROLE_SUGGESTIONS = ["Ordförande", "Vice ordförande", "Kassör", "Sekreterare", "Ledamot", "Suppleant", "PR-ansvarig"];

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
        label="Föreningens namn"
        value={p.name}
        maxLength={100}
        autoComplete="organization"
        onChange={(e) => p.onName(e.target.value)}
        error={p.nameError}
      />
      <div className="flex flex-col gap-3">
        <span className="text-sm font-medium">Logga (valfritt)</span>
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
                Släpp en bild här
              </span>
            )}
            {p.busy && (
              <span className="absolute inset-0 grid place-items-center rounded-lg bg-surface/80">
                <Spinner className="text-xl text-ink-2" />
              </span>
            )}
            <span className="sr-only">{p.logoUrl ? "Byt logga" : "Ladda upp logga"}</span>
          </button>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => input.current?.click()} loading={p.busy}>
                {p.logoUrl ? "Byt bild" : "Ladda upp logga"}
              </Button>
              {p.logoUrl && !p.busy && (
                <Button variant="ghost" onClick={p.onRemove}>
                  Ta bort
                </Button>
              )}
            </div>
            <p id={`${id}-hint`} className={cn(hintClass, "max-w-[22rem]")}>
              PNG, JPEG eller WebP. Simon Says beskär den till en kvadrat. Den syns bara här i Simon Says – på
              föreningssidan och i listan – aldrig i mötesdokumenten.
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

export interface BoardStepProps {
  orgName: string;
  rows: BoardRow[];
  inviteUrl: string;
  /** Each returns an error sentence, or null when it worked. */
  onAdd: (input: BoardInput, memberUserId?: string) => Promise<string | null>;
  onUpdate: (personId: string, input: BoardInput) => Promise<string | null>;
  onRemove: (personId: string) => Promise<string | null>;
  /** The signed-in admin's own e-mail, to say "du" on their row. */
  myEmail?: string | null;
}

export function BoardStep(p: BoardStepProps) {
  const id = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const invited = p.rows.filter((r) => r.status === "invited");
  return (
    <div className="flex flex-col gap-6">
      <datalist id={`${id}-roles`}>
        {ROLE_SUGGESTIONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      {p.rows.length === 0 ? (
        <EmptyState title="Vilka sitter i styrelsen?">
          <p>
            Börja med dig själv. Namnen hjälper Simon Says att känna igen vem som talar, och rollerna hamnar i
            protokollet: ”Kassör: boka lokal”. E-post behövs bara för den som ska kunna starta möten och få
            dokumenten.
          </p>
        </EmptyState>
      ) : (
        <ul className="flex flex-col rounded-lg bg-surface shadow-panel" aria-label="Styrelsen">
          {p.rows.map((row) => {
            const key = row.personId ?? `m:${row.member?.userId}`;
            return (
              <li key={key} className="border-t border-line first:border-t-0">
                {editing === key ? (
                  <PersonForm
                    uid={`${id}-${key}`}
                    rolesList={`${id}-roles`}
                    initial={{ name: row.name ?? "", role: row.role ?? "", email: row.personId ? (row.email ?? "") : "" }}
                    emailLocked={row.status === "account"}
                    submitLabel={row.personId ? "Spara" : "Lägg till"}
                    onCancel={() => setEditing(null)}
                    onSubmit={async (input) => {
                      const err = row.personId ? await p.onUpdate(row.personId, input) : await p.onAdd(input, row.member?.userId);
                      if (!err) setEditing(null);
                      return err;
                    }}
                  />
                ) : (
                  <BoardRowView row={row} invite={{ orgName: p.orgName, inviteUrl: p.inviteUrl }} me={Boolean(p.myEmail && row.email?.toLowerCase() === p.myEmail)} onEdit={() => setEditing(key)} onRemove={row.personId ? () => p.onRemove(row.personId!) : undefined} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-3 rounded-lg border border-dashed border-rail p-4">
        <span className="text-sm font-medium">Lägg till någon</span>
        <PersonForm uid={`${id}-new`} rolesList={`${id}-roles`} initial={{ name: "", role: "", email: "" }} submitLabel="Lägg till" onSubmit={(input) => p.onAdd(input)} resetOnSuccess />
      </div>

      {invited.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-2">
            Simon Says skickar ingen e-post åt er. Skicka länken själv – från din e-post med knappen
            <span className="font-medium"> Skicka inbjudan</span>, eller i styrelsens chatt. Den som loggar in med adressen ni
            skrev kopplas till sitt namn här.
          </p>
          <CopyField id={`${id}-invite`} value={p.inviteUrl} label="Inbjudningslänk" />
        </div>
      )}
    </div>
  );
}

function statusLine(row: BoardRow, me: boolean): ReactNode {
  if (row.status === "account") {
    return (
      <>
        <span className="text-green">Har konto</span>
        {row.email && <span className="wrap-anywhere"> · {row.email}</span>}
        {me && " · du"}
        {row.member?.role === "admin" && " · admin"}
      </>
    );
  }
  if (row.status === "invited") return <span className="wrap-anywhere">Inbjuden · {row.email}</span>;
  return "Bara namn – lägg till e-post om hen ska kunna starta möten";
}

function BoardRowView({ row, me, invite, onEdit, onRemove }: { row: BoardRow; me: boolean; invite: { orgName: string; inviteUrl: string }; onEdit: () => void; onRemove?: () => Promise<string | null> }) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const display = row.name ?? row.email ?? "Okänd";
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <div className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3">
        <span className="mt-0.5 grid size-9 flex-none place-items-center rounded-full bg-sunk text-sm font-medium text-ink-2" aria-hidden="true">
          {(row.name ?? "?").trim().charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="font-medium wrap-anywhere">
            {row.name ?? <span className="text-ink-3">Namn saknas</span>}
            {row.role && <span className="font-normal text-ink-2"> · {row.role}</span>}
          </span>
          <span className="text-sm text-ink-3">{statusLine(row, me)}</span>
          {row.status === "invited" && row.email && (
            <span className="mt-1">
              <InviteButton email={row.email} name={row.name} orgName={invite.orgName} inviteUrl={invite.inviteUrl} />
            </span>
          )}
          {!row.personId && (
            <span className="mt-2">
              <Button variant="secondary" size="sm" icon={<IconPlus size={16} />} onClick={onEdit}>
                Lägg till namn
              </Button>
            </span>
          )}
        </span>
        <span className="flex items-center gap-1">
          {row.personId && (
            <Button variant="ghost" size="sm" icon={<IconPencil size={16} />} iconOnly onClick={onEdit}>
              {`Ändra ${display}`}
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
              {`Ta bort ${display} ur listan`}
            </Button>
          )}
        </span>
      </div>
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}

/** "Skicka inbjudan": opens the admin's own mail with the invite link (filled in by the container). */
function InviteButton({ email, name, orgName, inviteUrl }: { email: string; name: string | null; orgName: string; inviteUrl: string }) {
  const ctx = { orgName, inviteUrl };
  return (
    <a className="-ml-2 inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-blue no-underline hover:bg-blue-wash max-md:min-h-11" href={inviteMailto(email, ctx.orgName, ctx.inviteUrl, name)}>
      Skicka inbjudan
      <IconExternal size={14} />
    </a>
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
}: {
  uid: string;
  rolesList: string;
  initial: BoardInput;
  submitLabel: string;
  onSubmit: (input: BoardInput) => Promise<string | null>;
  onCancel?: () => void;
  resetOnSuccess?: boolean;
  emailLocked?: boolean;
}) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!v.name.trim()) {
      setError("Skriv ett namn, t.ex. Anna Berg.");
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
          <Label htmlFor={`${uid}-name`}>Namn</Label>
          <Input ref={nameRef} id={`${uid}-name`} value={v.name} maxLength={100} placeholder="Anna Berg" autoComplete="off" onChange={(e) => setV({ ...v, name: e.target.value })} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-role`}>Roll</Label>
          <Input id={`${uid}-role`} value={v.role} maxLength={40} placeholder="Kassör" list={rolesList} autoComplete="off" onChange={(e) => setV({ ...v, role: e.target.value })} />
        </div>
      </div>
      {!emailLocked && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-email`}>
            E-post <span className="font-normal text-ink-3">(valfritt – bjuder in)</span>
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
            Avbryt
          </Button>
        )}
      </div>
      {error && <Note tone="danger">{error}</Note>}
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
  return (
    <div className="flex flex-col gap-6">
      {p.folderSet ? (
        <div className="flex items-center gap-4 rounded-lg bg-surface p-4 shadow-panel">
          <span className="grid size-11 flex-none place-items-center rounded-md bg-sunk text-ink-2">
            <IconFolder size={22} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium wrap-anywhere">{p.folderName ?? "Mötesmappen"}</span>
            <span className="text-sm text-green">Vald – nya mötesdokument hamnar här</span>
          </span>
          {p.pickerEnabled && (
            <Button variant="ghost" size="sm" onClick={p.onPick} loading={p.busy}>
              Byt
            </Button>
          )}
        </div>
      ) : (
        <EmptyState
          title="Ingen mötesmapp än"
          action={
            p.pickerEnabled ? (
              <Button variant="secondary" icon={<IconFolder size={18} />} onClick={p.onPick} loading={p.busy}>
                Välj mapp i Google Drive
              </Button>
            ) : undefined
          }
        >
          <p>
            Välj mappen där ni redan har era protokoll, eller skapa en ny i Drive först (t.ex. ”Styrelsen 2026–2027”).
            Dela den med styrelsen, så kommer alla åt dokumenten.
          </p>
        </EmptyState>
      )}
      {!p.pickerEnabled && (
        <Banner tone="neutral" live={false}>
          Google-väljaren är inte inställd än. Utan mötesmapp hamnar dokumenten i den som startar mötets egen Drive.
        </Banner>
      )}
      <Note>{p.message}</Note>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Så brukar ni ha möten

export type WeeklyChoice = "veckomote" | "learn" | "current";

export type StadgarPhase =
  | { phase: "idle" }
  | { phase: "reading" }
  | { phase: "review"; board: string[]; arsmote: string[] }
  | { phase: "saving"; board: string[]; arsmote: string[] }
  | { phase: "saved"; board: number; arsmote: number }
  | { phase: "error"; message: string };

export interface FormatStepProps {
  choice: WeeklyChoice;
  onChoice: (c: WeeklyChoice) => void;
  /** The förening's current default when it is not plain Veckomöte/Enkel (e.g. "Eget (2026-11-02)"). */
  currentName?: string | null;
  /** The "learn from old minutes" flow (FormatEditor's LearnFormatView), shown under its option. */
  learn?: ReactNode;
  pickerEnabled: boolean;
  stadgar: StadgarPhase;
  /** Already saved from an earlier visit. */
  stadgarSaved?: { styrelse: boolean; arsmote: boolean };
  onStadgarPick: () => void;
  onStadgarChange: (board: string[], arsmote: string[]) => void;
  onStadgarSave: () => void;
  onStadgarCancel: () => void;
}

const VECKO_PREVIEW = ["Godkänn dagordning", "Må-runda", "Från förra veckan", "Era punkter", "Övrigt"];

export function FormatStep(p: FormatStepProps) {
  const id = useId();
  const options: { value: WeeklyChoice; title: string; hint: ReactNode }[] = [
    ...(p.currentName ? [{ value: "current" as const, title: `Behåll ${p.currentName}`, hint: "Formatet ni redan har valt." }] : []),
    {
      value: "veckomote",
      title: "Veckomöte",
      hint: (
        <>
          Det vanliga mötet: {VECKO_PREVIEW.join(" · ")}. Uppgifterna följs upp nästa gång.
        </>
      ),
    },
    {
      value: "learn",
      title: "Som våra gamla protokoll",
      hint: "Simon Says läser strukturen i ett par gamla protokoll (bara rubrikerna och ordningen) och skriver likadant.",
    },
  ];
  return (
    <div className="flex flex-col gap-10">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-lg font-semibold">Era vanliga möten</legend>
        {options.map((o) => {
          const checked = p.choice === o.value;
          return (
            <div key={o.value} className={cn("rounded-lg border bg-surface transition-colors duration-120", checked ? "border-ink" : "border-line hover:border-control")}>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 p-4">
                <input type="radio" name={`${id}-weekly`} value={o.value} checked={checked} onChange={() => p.onChoice(o.value)} className="mt-1 size-4 accent-[var(--ink)]" />
                <span className="flex flex-col gap-1">
                  <span className="font-medium">
                    {o.title}
                    {o.value === "veckomote" && !p.currentName && <span className="font-normal text-ink-3"> (förvalt)</span>}
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
            Stadgar <span className="font-normal text-ink-3">(valfritt)</span>
          </h2>
          <p className="max-w-[34rem] text-sm text-ink-2">
            Har ni stadgar ser Simon Says till att <strong>styrelsemötena</strong> får punkterna stadgarna kräver och att
            <strong> årsmötet</strong> får dagordningen de beskriver. Ni ser och kan ändra allt innan det sparas.
          </p>
        </div>
        <StadgarBlock {...p} uid={id} />
      </section>
    </div>
  );
}

function StadgarBlock(p: FormatStepProps & { uid: string }) {
  const s = p.stadgar;
  if (s.phase === "reading") {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-2" role="status" aria-live="polite">
        <Spinner /> Simon Says läser stadgarna … det tar ungefär en halv minut.
      </p>
    );
  }
  if (s.phase === "review" || s.phase === "saving") {
    return (
      <div className="mt-2 flex flex-col gap-6 animate-notice-in">
        <ItemList
          uid={`${p.uid}-board`}
          title="Varje styrelsemöte"
          empty="Stadgarna kräver inget särskilt på styrelsemöten. Styrelsemöten följer standardprotokollet."
          items={s.board}
          max={15}
          onChange={(board) => p.onStadgarChange(board, s.arsmote)}
        />
        <ItemList
          uid={`${p.uid}-ars`}
          title="Årsmötet"
          empty="Stadgarna listar ingen dagordning för årsmötet. Årsmötet följer standarddagordningen."
          items={s.arsmote}
          max={18}
          onChange={(arsmote) => p.onStadgarChange(s.board, arsmote)}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={p.onStadgarSave} loading={s.phase === "saving"}>
            Spara för styrelse- och årsmöten
          </Button>
          <Button variant="ghost" onClick={p.onStadgarCancel} disabled={s.phase === "saving"}>
            Avbryt
          </Button>
        </div>
      </div>
    );
  }
  if (s.phase === "saved" || (s.phase === "idle" && p.stadgarSaved && (p.stadgarSaved.styrelse || p.stadgarSaved.arsmote))) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="flex items-start gap-2 text-sm text-green" aria-live="polite">
          <IconCheck size={18} className="mt-[0.1rem] flex-none" />
          <span>
            {s.phase === "saved"
              ? `Sparat: ${plural(s.board, "punkt", "punkter")} på varje styrelsemöte${s.arsmote ? ` och årsmötets ${plural(s.arsmote, "punkt", "punkter")}` : ", årsmötet följer standarden"}.`
              : "Styrelse- och årsmöten följer era stadgar."}
          </span>
        </p>
        {p.pickerEnabled && (
          <Button variant="ghost" size="sm" onClick={p.onStadgarPick}>
            Läs in stadgarna igen
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-3">
      {s.phase === "error" && <Banner tone="danger" live={false}>{s.message}</Banner>}
      {p.pickerEnabled ? (
        <Button variant="secondary" onClick={p.onStadgarPick}>
          {s.phase === "error" ? "Försök igen" : "Välj stadgarna i Google Drive"}
        </Button>
      ) : (
        <p className="text-sm text-ink-3">Google-väljaren är inte inställd än, så stadgarna kan läsas in senare.</p>
      )}
      <p className={hintClass}>Ett Google-dokument eller en PDF. Simon Says sparar bara punkterna, aldrig stadgarna.</p>
    </div>
  );
}

function ItemList({ uid, title, empty, items, max, onChange }: { uid: string; title: string; empty: string; items: string[]; max: number; onChange: (items: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = (e: FormEvent) => {
    e.preventDefault();
    const clean = draft.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!clean || items.length >= max) return;
    onChange([...items, clean]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">
        {title} <span className="font-normal text-ink-3">· {plural(items.length, "punkt", "punkter")}</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-ink-3">{empty}</p>
      ) : (
        <ol className="flex flex-col rounded-lg bg-surface shadow-panel">
          {items.map((item, i) => (
            <li key={`${i}-${item}`} className="flex min-h-11 items-center gap-3 border-t border-line px-4 py-1 first:border-t-0">
              <span className="w-6 flex-none font-mono text-xs text-ink-3">{i + 1}.</span>
              <span className="min-w-0 flex-1 text-sm wrap-anywhere">{item}</span>
              <Button variant="danger-ghost" size="sm" iconOnly icon={<IconTrash size={16} />} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                {`Ta bort ${item}`}
              </Button>
            </li>
          ))}
        </ol>
      )}
      {items.length < max && (
        <form onSubmit={add} className="flex gap-2">
          <Label htmlFor={`${uid}-add`} className="sr-only">
            Ny punkt under {title}
          </Label>
          <Input id={`${uid}-add`} value={draft} maxLength={80} placeholder="Lägg till punkt" onChange={(e) => setDraft(e.target.value)} />
          <Button type="submit" variant="ghost" icon={<IconPlus size={18} />} disabled={!draft.trim()}>
            Lägg till
          </Button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 5. Era tidigare möten

export function HistoryStep({ importHref, historyCount, onOpen }: { importHref: string; historyCount: number; onOpen?: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-col gap-4 text-sm text-ink-2">
        {[
          ["Välj protokoll", "Markera era gamla protokoll i Google Drive – gärna ett helt verksamhetsår."],
          ["Se vad det kostar", "Innan något läses ser du hur många möten det blir och vad det kostar."],
          ["Simon Says läser i tidsordning", "Beslut, uppgifter och det ni jobbat med hamnar i Översikt, och blir förslag på mål."],
        ].map(([t, d], i) => (
          <li key={t} className="flex gap-4">
            <span className="grid size-7 flex-none place-items-center rounded-full bg-sunk font-mono text-xs text-ink-2" aria-hidden="true">
              {i + 1}
            </span>
            <span className="flex flex-col gap-0.5 pt-0.5">
              <span className="font-medium text-ink">{t}</span>
              {d}
            </span>
          </li>
        ))}
      </ol>
      {historyCount > 0 && (
        <p className="flex items-center gap-2 text-sm text-green">
          <IconCheck size={18} /> {plural(historyCount, "protokoll", "protokoll")} inlästa hittills.
        </p>
      )}
      <div className="flex flex-col items-start gap-2">
        <ButtonLink href={importHref} variant="secondary" onClick={onOpen}>
          {historyCount > 0 ? "Läs in fler protokoll" : "Välj gamla protokoll"}
        </ButtonLink>
        <p className={hintClass}>Öppnar Översikt. Kom tillbaka hit med ”Kom igång” på föreningssidan.</p>
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
  const id = useId();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-lg bg-surface p-5 shadow-panel">
        <p className="font-medium">Simon Says lär sig rösterna från namnrundan i ert första möte — ingen behöver spela in något.</p>
        <p className="text-sm text-ink-2">
          Alla säger sitt namn i namnrundan, som vanligt. Den meningen blir rösten Simon Says känner igen – en
          gång, aldrig mer. Från andra mötet står namnen där direkt.
        </p>
        <p className="text-sm text-ink-3">
          Funktionen testas fortfarande och slås på senare. En röst är känslig information, så den sparas bara för den
          som har sagt ja, kan tas bort när som helst och tas bort när någon lämnar föreningen. Utan ja fungerar
          namnrundan som i dag.
        </p>
      </div>
      {p.people.length === 0 ? (
        <EmptyState title="Ingen i styrelsen än" action={<Button variant="secondary" onClick={p.onBoard}>Lägg till styrelsen</Button>}>
          <p>Lägg till styrelsen först, så kan du bocka för vilka som har sagt ja.</p>
        </EmptyState>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-3 text-sm font-medium">Vilka har sagt ja till att Simon Says lär sig deras röst?</legend>
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
                  {person.consent ? "Har sagt ja. Hen tillfrågas igen innan något sparas." : undefined}
                </Check>
              </li>
            ))}
          </ul>
          <p className={cn(hintClass, "mt-2")}>Fråga var och en. Bocka bara för den som själv har sagt ja.</p>
          <Note tone="danger">{p.error}</Note>
        </fieldset>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Klart

export function DoneStep({ done, skipped, prepareHref, orgHref, onGo }: { done: StepId[]; skipped: StepId[]; prepareHref: string; orgHref: string; onGo?: (s: StepId) => void }) {
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
                {s.title}
                <span className="sr-only">{isDone ? ": klart" : ": hoppades över"}</span>
              </span>
              {!isDone && onGo && (
                <Button variant="ghost" size="sm" onClick={() => onGo(s.id)}>
                  {skipped.includes(s.id) ? "Gör nu" : "Öppna"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3 max-[30rem]:flex-col max-[30rem]:items-stretch">
        <ButtonLink href={prepareHref} variant="primary" size="lg">
          Förbered första mötet →
        </ButtonLink>
        <ButtonLink href={orgHref} variant="ghost" size="lg">
          Till föreningen
        </ButtonLink>
      </div>
    </div>
  );
}
