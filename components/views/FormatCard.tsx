"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuNote,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconChevronDown } from "@/components/ui/icons";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { formatLabel, formatName } from "@/lib/formats/standard";
import type { FormatKind, FormatProfile } from "@/lib/formats/schema";
import { LearnFormatView, useFormatFlow } from "./FormatEditor";
import { StadgarArsmote, useStadgarArsmote } from "./StadgarArsmote";

export interface FormatCardProps {
  orgId: string;
  /** The org default: its row id (null for Enkel without a row) and profile. */
  current: { kind: FormatKind; name: string; id?: string | null; profile?: FormatProfile };
  isAdmin: boolean;
  /** Versions saved for this org; custom ones (learned, or with the stadgar's items) can be re-adopted. */
  formats: { id: string; kind: FormatKind; isDefault: boolean; createdAt: string; custom?: boolean; requiredCount?: number; name?: string }[];
  /** Admins: hidden `orgId`, `choice` = a standard kind or `id:<profile id>`. */
  changeFormat?: FormAction;
  /** The Google Picker is configured: admins can learn a format or read the stadgar from Drive. */
  pickerEnabled?: boolean;
}

const STANDARD_KINDS = ["veckomote", "styrelseprotokoll", "enkel"] as const;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The förening's meeting format. Everyone sees the state (format, its version,
 * the stadgar's items behind a disclosure); admins get one "Ändra" menu that starts each change:
 * switch format, adjust it, learn one (B2), the årsmöte from the stadgar (todo #15). The switcher and
 * the flows' progress, errors and editor show in the card. (The meeting folder has its own editor.)
 */
export function FormatCard({ orgId, current, isAdmin, formats, changeFormat, pickerEnabled = false }: FormatCardProps) {
  // Custom versions (a learned format, a Styrelseprotokoll with the stadgar's items, an adjusted
  // standard) are offered by id: choosing the bare standard would drop what makes them theirs (R3-I2).
  const t = useTranslations("formatEditor");
  const common = useTranslations("common");
  const locale = useLocale();
  const stadgarCopy = useTranslations("stadgar");
  const flowCopy = (v: "learn" | "customize") => ({ start: t(`flows.${v}.start`), hint: t(`flows.${v}.hint`) });
  const custom = formats
    .map((f) => ({ ...f, custom: f.custom ?? f.kind === "learned", requiredCount: f.requiredCount ?? 0 }))
    .filter((f) => f.custom);
  const currentRow = current.id ? custom.find((f) => f.id === current.id) : undefined;
  const required = current.profile?.requiredItems ?? [];
  const selected = currentRow ? `id:${currentRow.id}` : current.kind === "learned" ? "" : current.kind;

  // A standard format is named in the UI language; a custom one keeps the name it was saved with.
  const name = currentRow?.name ?? (current.kind === "learned" ? t("card.ownFormat") : currentRow ? current.name : formatName(current.kind, locale));
  const version = currentRow
    ? t(currentRow.kind === "learned" ? "card.versionLearned" : "card.versionCustom", { date: currentRow.createdAt.slice(0, 10) })
    : null;
  const meta = version ? capitalize(version) : null;

  const flow = useFormatFlow(orgId, current.profile);
  // The stadgar → the årsmöte's agenda (todo #15); shown in the card while it runs.
  const stadgar = useStadgarArsmote(orgId);
  const [stadgarOpen, setStadgarOpen] = useState(false);
  const closeStadgar = () => {
    stadgar.cancel();
    setStadgarOpen(false);
  };
  const [changing, setChanging] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const focusSelect = useRef(false);

  // Back from a flow's editor (approved or cancelled) or the switcher: focus returns to "Ändra".
  const wasOpen = useRef(false);
  const open = changing || flow.view.phase !== "idle" || stadgarOpen;
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  const showChange = isAdmin && !!changeFormat;
  const showCustomize = isAdmin && !!current.profile;

  const menu = isAdmin && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} variant="secondary" size="sm" data-format-menu="">
          {t("card.change")}
          <IconChevronDown size={16} className="ml-1 inline-block align-[-0.2em] text-ink-2" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        onCloseAutoFocus={(e) => {
          if (!focusSelect.current) return;
          focusSelect.current = false;
          e.preventDefault();
          requestAnimationFrame(() => selectRef.current?.focus());
        }}
      >
        {showChange && (
          <DropdownMenuItem
            hint={t("card.switchHint")}
            onSelect={() => {
              flow.reset();
              closeStadgar();
              focusSelect.current = true;
              setChanging(true);
            }}
          >
            {t("card.switch")}
          </DropdownMenuItem>
        )}
        {showCustomize && (
          <DropdownMenuItem
            hint={flowCopy("customize").hint}
            onSelect={() => {
              setChanging(false);
              closeStadgar();
              flow.start("customize");
            }}
          >
            {flowCopy("customize").start}
          </DropdownMenuItem>
        )}
        {(showChange || showCustomize) && <DropdownMenuSeparator />}
        <DropdownMenuItem
          hint={flowCopy("learn").hint}
          disabled={!pickerEnabled}
          onSelect={() => {
            setChanging(false);
            closeStadgar();
            void flow.start("learn");
          }}
        >
          {flowCopy("learn").start}
        </DropdownMenuItem>
        {pickerEnabled && (
          <>
            <DropdownMenuItem
              hint={stadgarCopy("lead")}
              onSelect={() => {
                setChanging(false);
                flow.reset();
                setStadgarOpen(true);
                void stadgar.pick();
              }}
            >
              {stadgarCopy("start")}
            </DropdownMenuItem>
          </>
        )}
        {!pickerEnabled && <DropdownMenuNote>{t("card.pickerOff")}</DropdownMenuNote>}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Panel title={t("card.title")} titleId="format-title" actions={menu}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-base font-medium text-ink">{name}</p>
          {meta && <p className="text-sm text-ink-3">{meta}</p>}
        </div>

        {required.length> 0 && (
          <details className="group text-sm">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm font-medium text-ink-2 select-none hover:text-ink max-md:min-h-11 [&::-webkit-details-marker]:hidden">
              <IconChevronDown size={16} className="-rotate-90 transition-transform duration-120 group-open:rotate-0" />
              {t("card.statutesRequire", { count: required.length })}
            </summary>
            <div className="mt-2 flex flex-col gap-3 pl-5">
              <p className="text-ink-3">{t("card.everyAgenda")}</p>
              <ul className="list-dash pl-4 text-xs text-ink-3 marker:text-ink-3">
                {required.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          </details>
        )}

        {isAdmin && changing && changeFormat && (
          <form
            action={async (form) => {
              await changeFormat(form);
              setChanging(false);
            }}
            className="flex flex-col gap-2 border-t border-line pt-4"
          >
            <input type="hidden" name="orgId" value={orgId} />
            <Label htmlFor="format-choice">{t("card.switch")}</Label>
            <div className="flex flex-wrap gap-2">
              <NativeSelect ref={selectRef} id="format-choice" name="choice" defaultValue={selected} className="min-w-[14rem] flex-1 max-md:basis-full">
                {selected === "" && (
                  <option value="" disabled>
                    {formatName("learned", locale)}
                  </option>
                )}
                {STANDARD_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {formatName(k, locale)}
                  </option>
                ))}
                {custom.map((f) => (
                  <option key={f.id} value={`id:${f.id}`}>
                    {formatLabel(f, locale)}
                    {f.isDefault ? t("card.inUse") : ""}
                  </option>
                ))}
              </NativeSelect>
              <SubmitButton variant="primary" pendingLabel={t("card.switching")}>
                {t("card.switchShort")}
              </SubmitButton>
              <Button variant="ghost" onClick={() => setChanging(false)}>
                {common("cancel")}
              </Button>
            </div>
          </form>
        )}

        {isAdmin && stadgarOpen && (
          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <p className="text-sm text-ink-2">{stadgarCopy("lead")}</p>
            <StadgarArsmote
              uid="format-stadgar"
              stadgar={stadgar.stadgar}
              pickerEnabled={pickerEnabled}
              onPick={() => void stadgar.pick()}
              onChange={stadgar.change}
              onSave={() => void stadgar.save()}
              onCancel={closeStadgar}
            />
            {(stadgar.stadgar.phase === "idle" || stadgar.stadgar.phase === "saved" || stadgar.stadgar.phase === "error") && (
              <div>
                <Button variant="ghost" size="sm" onClick={closeStadgar}>
                  {common("close")}
                </Button>
              </div>
            )}
          </div>
        )}

        {isAdmin && flow.view.phase !== "idle" && (
          <div className="border-t border-line pt-4">
            <LearnFormatView
              orgId={orgId}
              view={flow.view}
              variant={flow.variant}
              onStart={() => void flow.start(flow.variant)}
              onCancel={flow.reset}
              onApproved={flow.reset}
            />
          </div>
        )}
      </div>
    </Panel>
  );
}
