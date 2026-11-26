"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button, Spinner } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Check } from "@/components/ui/Field";
import { IconCheck, IconChevronRight, IconDoc, IconFolder, IconSearch, IconX } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import type { DriveFolder, ImportFile } from "@/lib/history/drive-list";
import { MAX_IMPORT_DOCS } from "@/lib/history/limits";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

// The protocol import's own Drive browser (no Google Picker), on the admin's drive.readonly
// grant: step 1 picks folders, step 2 lists the Google Docs in them to tick. Everything comes
// from POST /api/orgs/<id>/history/drive; nothing here is stored.

const MAX_FOLDERS = 20;

/** `needs_drive_access`: the grant lacks drive.readonly (withdrawn, or replaced by a plain sign-in). */
type DriveFetchResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

async function driveCall<T>(orgId: string, body: unknown): Promise<DriveFetchResult<T>> {
  try {
    const res = await fetch(`/api/orgs/${orgId}/history/drive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
    if (!res.ok || !json) return { ok: false, error: json?.error ?? "error", message: json?.message ?? "Något gick fel. Försök igen om en liten stund." };
    return { ok: true, data: json };
  } catch {
    return { ok: false, error: "network", message: "Vi nådde inte servern. Kontrollera nätet och försök igen." };
  }
}

type Where = "root" | "shared" | "drives";
const PLACES: { key: Where; label: string }[] = [
  { key: "root", label: "Min enhet" },
  { key: "shared", label: "Delade med mig" },
  { key: "drives", label: "Delade enheter" },
];

const rowBase = "flex min-h-12 items-center gap-3 border-t border-line px-3 max-md:min-h-14 [li:first-child>&]:border-t-0";

// ---------------------------------------------------------------------------------------------
// Step 1: folders

export function FolderStep({
  orgId,
  meetingFolder,
  initialSelected,
  initialSubfolders = true,
  onNext,
  onCancel,
  onNeedsAccess,
  onRemoved,
}: {
  orgId: string;
  meetingFolder: { id: string; name: string } | null;
  initialSelected?: DriveFolder[];
  initialSubfolders?: boolean;
  onNext: (folders: DriveFolder[], subfolders: boolean) => void;
  onCancel: () => void;
  onNeedsAccess: () => void;
  /** "Ta bort läsåtkomst" done. */
  onRemoved: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const removeAccess = async () => {
    setRemoving(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/history/drive`, { method: "DELETE" });
      if (res.ok) onRemoved();
      else setError("Läsåtkomsten kunde inte tas bort. Försök igen.");
    } catch {
      setError("Vi nådde inte servern. Kontrollera nätet och försök igen.");
    } finally {
      setRemoving(false);
    }
  };
  const [where, setWhere] = useState<Where>("root");
  const [path, setPath] = useState<DriveFolder[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DriveFolder[]>(() => initialSelected ?? (meetingFolder ? [meetingFolder] : []));
  const [subfolders, setSubfolders] = useState(initialSubfolders);
  const seq = useRef(0);

  // The search box waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const body = useMemo(() => {
    if (search) return { action: "folders", place: "search", query: search };
    const here = path.at(-1);
    if (here) return { action: "folders", place: "folder", id: here.id, ...(here.driveId ? { driveId: here.driveId } : {}) };
    return { action: "folders", place: where };
  }, [search, path, where]);

  const load = async (pageToken?: string) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    const r = await driveCall<{ folders: DriveFolder[]; nextPageToken: string | null }>(orgId, { ...body, ...(pageToken ? { pageToken } : {}) });
    if (mine !== seq.current) return;
    setLoading(false);
    if (!r.ok) {
      if (r.error === "needs_drive_access") onNeedsAccess();
      else setError(r.message);
      return;
    }
    setFolders((f) => (pageToken ? [...f, ...r.data.folders] : r.data.folders));
    setNext(r.data.nextPageToken);
  };

  useEffect(() => {
    setFolders([]);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the place changes
  }, [body]);

  const isSelected = (id: string) => selected.some((f) => f.id === id);
  const toggle = (f: DriveFolder) =>
    setSelected((s) => (s.some((x) => x.id === f.id) ? s.filter((x) => x.id !== f.id) : s.length >= MAX_FOLDERS ? s : [...s, f]));
  const open = (f: DriveFolder) => {
    setQuery("");
    setSearch("");
    setPath((p) => [...p, f]);
  };
  const full = selected.length >= MAX_FOLDERS;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="font-medium">Steg 1 av 2: Välj mapparna med protokollen</p>
        <p className="text-sm text-ink-3 max-w-[68ch]">
          Kryssa i en eller flera mappar. I nästa steg ser du mötena som ligger i dem och väljer vilka som ska läsas in.
        </p>
      </div>

      {meetingFolder && (
        <div className="rounded-lg border border-line bg-surface">
          <FolderRow
            folder={meetingFolder}
            label={meetingFolder.name}
            meta="Föreningens mötesmapp"
            className="border-t-0"
            checked={isSelected(meetingFolder.id)}
            disabled={full && !isSelected(meetingFolder.id)}
            onToggle={() => toggle(meetingFolder)}
            onOpen={() => {
              setWhere("root");
              setPath([meetingFolder]);
              setQuery("");
            }}
          />
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="relative">
          <IconSearch size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <Input
            type="search"
            aria-label="Sök mapp"
            placeholder="Sök mapp efter namn"
            value={query}
            maxLength={100}
            className="pl-9"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {!search && (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Var i Drive">
            {PLACES.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={where === p.key && !path.length ? "secondary" : "ghost"}
                aria-pressed={where === p.key}
                onClick={() => {
                  setWhere(p.key);
                  setPath([]);
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
        )}
        {!search && path.length > 0 && (
          <nav aria-label="Mappar" className="flex flex-wrap items-center gap-1 text-sm text-ink-3">
            <button type="button" className="rounded-md px-1 py-0.5 hover:text-ink" onClick={() => setPath([])}>
              {PLACES.find((p) => p.key === where)?.label}
            </button>
            {path.map((f, i) => (
              <span key={f.id} className="flex items-center gap-1">
                <IconChevronRight size={14} />
                {i === path.length - 1 ? (
                  <span className="text-ink wrap-anywhere" aria-current="page">
                    {f.name}
                  </span>
                ) : (
                  <button type="button" className="rounded-md px-1 py-0.5 hover:text-ink wrap-anywhere" onClick={() => setPath((p) => p.slice(0, i + 1))}>
                    {f.name}
                  </button>
                )}
              </span>
            ))}
          </nav>
        )}

        <div className="rounded-lg border border-line bg-surface" aria-busy={loading}>
          {error ? (
            <div className="p-3">
              <Banner tone="danger" action={<Button size="sm" variant="secondary" onClick={() => load()}>Försök igen</Button>}>
                {error}
              </Banner>
            </div>
          ) : folders.length === 0 && loading ? (
            <p className="flex items-center gap-2 px-3 py-4 text-sm text-ink-3" role="status">
              <Spinner /> Hämtar mappar …
            </p>
          ) : folders.length === 0 ? (
            <p className="px-3 py-4 text-sm text-ink-3">
              {search ? `Ingen mapp heter något med ”${search}”.` : path.length ? "Inga mappar här inne." : "Inga mappar här."}
            </p>
          ) : (
            <ul className="max-h-[22rem] overflow-y-auto overscroll-contain">
              {folders.map((f) => (
                <li key={f.id}>
                  <FolderRow
                    folder={f}
                    label={f.name}
                    checked={isSelected(f.id)}
                    disabled={full && !isSelected(f.id)}
                    onToggle={() => toggle(f)}
                    onOpen={() => open(f)}
                  />
                </li>
              ))}
              {next && (
                <li className="border-t border-line p-2">
                  <Button size="sm" variant="ghost" loading={loading} onClick={() => load(next)}>
                    Visa fler mappar
                  </Button>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      {selected.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-3">
            {plural(selected.length, "mapp vald", "mappar valda")}
            {full && ` (högst ${MAX_FOLDERS})`}
          </p>
          <ul className="flex flex-wrap gap-2">
            {selected.map((f) => (
              <li key={f.id} className="flex max-w-full items-center gap-1 rounded-md border border-control bg-surface py-0.5 pl-2 pr-0.5 text-sm">
                <IconFolder size={14} className="flex-none text-ink-3" />
                <span className="truncate">{f.name}</span>
                <Button size="sm" variant="ghost" iconOnly icon={<IconX size={14} />} onClick={() => toggle(f)}>
                  {`Ta bort ${f.name}`}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Check id="import-subfolders" title="Ta med undermappar" checked={subfolders} onCheckedChange={(v) => setSubfolders(v === true)}>
        Till exempel en mapp per termin eller år.
      </Check>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!selected.length} onClick={() => onNext(selected, subfolders)}>
          {selected.length ? `Visa mötena i ${plural(selected.length, "mapp", "mappar")}` : "Välj minst en mapp"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Avbryt
        </Button>
      </div>
      <p className="text-xs text-ink-3">
        Simon Says läsåtkomst till din Drive tas bort automatiskt efter 24 timmar.{" "}
        <Button variant="ghost" size="sm" loading={removing} onClick={removeAccess} className="h-auto min-h-0 px-1 py-0 text-xs underline max-md:min-h-11">
          Ta bort läsåtkomst nu
        </Button>
      </p>
    </div>
  );
}

function FolderRow({
  folder,
  label,
  meta,
  checked,
  disabled,
  onToggle,
  onOpen,
  className,
}: {
  folder: DriveFolder;
  label: string;
  meta?: string;
  className?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const id = `folder-${folder.id}`;
  return (
    <div className={cn(rowBase, className)}>
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onToggle} aria-label={`Välj ${label}`} />
      <button
        type="button"
        onClick={onOpen}
        className="group/open flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md py-2 text-left"
        aria-label={`Öppna ${label}`}
      >
        <IconFolder size={18} className="flex-none text-ink-3" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium wrap-anywhere">{label}</span>
          {meta && <span className="text-xs text-ink-3">{meta}</span>}
        </span>
        <IconChevronRight size={16} className="flex-none text-ink-3 transition-transform duration-120 group-hover/open:translate-x-0.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 2: the meetings in them

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("sv-SE", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).replace(/\./g, "");

const HINT: Record<ImportFile["status"], string | null> = {
  ready: null,
  template: "Ser ut som en mall, kallelse eller dagordning, inte ett protokoll.",
  docx: "Word-fil. Öppna den i Google Docs och spara som Google-dokument för att kunna läsa in den.",
  own: "Simon Says eget mötesdokument. Mötet finns redan med.",
  imported: "Kryssa i för att läsa in det igen (till exempel om dokumentet har fått fler möten).",
};

/**
 * The rows ticked from the start (and by "Välj alla"): the protocol-looking ones not imported
 * yet, oldest first, at most one import's worth. The rest show up next time, as the imported
 * ones are marked.
 */
export function defaultTicks(files: ImportFile[]): Set<string> {
  return new Set(files.filter((f) => f.status === "ready").slice(0, MAX_IMPORT_DOCS).map((f) => f.id));
}

/** Rows the admin may tick: also templates (a hunch, not a rule) and imported ones (read again). */
const canTick = (f: ImportFile) => f.status === "ready" || f.status === "template" || f.status === "imported";

export function FileStep({
  orgId,
  folders,
  subfolders,
  initialFiles,
  onBack,
  onNext,
  onNeedsAccess,
}: {
  orgId: string;
  folders: DriveFolder[];
  subfolders: boolean;
  /** /design only. */
  initialFiles?: { files: ImportFile[]; truncated: boolean; folders: number };
  onBack: () => void;
  onNext: (files: ImportFile[]) => void;
  onNeedsAccess: () => void;
}) {
  const [list, setList] = useState<{ files: ImportFile[]; truncated: boolean; folders: number } | null>(initialFiles ?? null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(() => (initialFiles ? defaultTicks(initialFiles.files) : new Set()));

  const load = async () => {
    setError(null);
    setList(null);
    const r = await driveCall<{ files: ImportFile[]; truncated: boolean; folders: number }>(orgId, {
      action: "files",
      folders: folders.map((f) => ({ id: f.id })),
      subfolders,
    });
    if (!r.ok) {
      if (r.error === "needs_drive_access") onNeedsAccess();
      else setError(r.message);
      return;
    }
    setList(r.data);
    setTicked(defaultTicks(r.data.files));
  };
  useEffect(() => {
    if (!initialFiles) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per folder choice
  }, []);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="danger">{error}</Banner>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={load}>
            Försök igen
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Tillbaka till mapparna
          </Button>
        </div>
      </div>
    );
  }
  if (!list) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-3" role="status" aria-live="polite">
        <Spinner /> Letar efter protokoll i {plural(folders.length, "mapp", "mappar")}
        {subfolders ? " och deras undermappar" : ""} … Bara namnen läses.
      </p>
    );
  }

  const all = defaultTicks(list.files);
  const ready = list.files.filter((f) => f.status === "ready").length;
  const done = list.files.filter((f) => f.status === "imported").length;
  const n = ticked.size;
  const allTicked = all.size > 0 && [...all].every((id) => ticked.has(id));
  const tooMany = n > MAX_IMPORT_DOCS;
  const toggle = (id: string) =>
    setTicked((t) => {
      const u = new Set(t);
      if (u.has(id)) u.delete(id);
      else u.add(id);
      return u;
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="font-medium">Steg 2 av 2: Välj protokollen</p>
        <p className="text-sm text-ink-3 max-w-[68ch]">
          {list.files.length === 0
            ? `Inga Google-dokument i ${plural(list.folders, "mapp", "mappar")}.`
            : `${plural(list.files.length, "dokument", "dokument")} i ${plural(list.folders, "mapp", "mappar")}, äldst först.${done ? ` ${plural(done, "är", "är")} redan inlästa.` : ""} Datum med ”gissat” kommer inte från namnet; Simon Says läser det riktiga datumet ur protokollet.`}
        </p>
      </div>
      {list.truncated && (
        <Banner tone="warning" live={false}>
          Mapparna innehåller fler dokument än Simon Says visar på en gång. Välj färre mappar, eller stäng av undermappar, för att se resten.
        </Banner>
      )}

      {list.files.length > 0 && (
        <div className="rounded-lg border border-line bg-surface">
          <div className={cn(rowBase, "border-t-0 bg-sunk/60 rounded-t-lg")}>
            <Checkbox
              id="import-all"
              checked={allTicked}
              disabled={!all.size}
              onCheckedChange={() => setTicked(allTicked ? new Set() : all)}
            />
            <label htmlFor="import-all" className="flex min-h-11 flex-1 cursor-pointer items-center text-sm font-medium">
              {ready > MAX_IMPORT_DOCS ? `Välj de ${MAX_IMPORT_DOCS} äldsta som inte är inlästa` : `Välj alla som inte är inlästa (${ready})`}
            </label>
          </div>
          <ul className="max-h-[28rem] overflow-y-auto overscroll-contain" aria-label="Dokument">
            {list.files.map((f) => (
              <li key={f.id}>
                <FileRow file={f} checked={ticked.has(f.id)} onToggle={() => toggle(f.id)} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p className={cn("text-sm", tooMany ? "text-amber font-medium" : "text-ink-3")} aria-live="polite">
          {tooMany
            ? `${plural(n, "protokoll", "protokoll")} valda. Du kan läsa in högst ${MAX_IMPORT_DOCS} åt gången; ta resten nästa gång.`
            : n
              ? `${plural(n, "protokoll", "protokoll")} valda. Nästa steg visar vad det kostar; inget skickas än.`
              : "Inga protokoll valda."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!n || tooMany} onClick={() => onNext(list.files.filter((f) => ticked.has(f.id)))}>
            {n ? `Fortsätt med ${plural(n, "protokoll", "protokoll")}` : "Välj protokoll"}
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Tillbaka till mapparna
          </Button>
        </div>
      </div>
    </div>
  );
}

function FileRow({ file, checked, onToggle }: { file: ImportFile; checked: boolean; onToggle: () => void }) {
  const id = `file-${file.id}`;
  const selectable = canTick(file);
  const hint = HINT[file.status];
  return (
    <div className={cn(rowBase, "items-start py-2")}>
      <Checkbox id={id} className="mt-0.5" checked={selectable && checked} disabled={!selectable} onCheckedChange={onToggle} />
      <label htmlFor={selectable ? id : undefined} className={cn("flex min-w-0 flex-1 flex-col gap-0.5", selectable && "cursor-pointer")}>
        <span className="flex items-start gap-2">
          <IconDoc size={16} className="mt-0.5 flex-none text-ink-3" />
          <span className={cn("font-medium wrap-anywhere", !selectable && file.status !== "imported" && "text-ink-3")}>{file.name}</span>
        </span>
        <span className="pl-6 text-xs text-ink-3">
          {file.date ? fmtDate(file.date) : "Inget datum"}
          {file.date && file.dateInferred && " (gissat)"}
          {" · "}
          <span className="wrap-anywhere">{file.folderName}</span>
          {file.status === "imported" && (
            <span className="text-green">
              {" · "}
              <IconCheck size={12} strokeWidth={2.5} className="inline align-[-0.1em]" /> Redan inläst
            </span>
          )}
        </span>
        {hint && <span className="pl-6 text-xs text-ink-3">{hint}</span>}
      </label>
    </div>
  );
}
