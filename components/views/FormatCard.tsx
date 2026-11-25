import { Button } from "@/components/ui/Button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { FORMAT_NAMES, formatLabel } from "@/lib/formats/standard";
import type { FormatKind, FormatProfile } from "@/lib/formats/schema";
import { CustomizeFormat, LearnFormat, StadgarFormat } from "./FormatEditor";
import { MeetingFolderButton } from "./MeetingFolderButton";

export interface FormatCardProps {
  orgId: string;
  /** The org default: its row id (null for Enkel without a row) and profile. */
  current: { kind: FormatKind; name: string; id?: string | null; profile?: FormatProfile };
  isAdmin: boolean;
  meetingFolder: { id: string | null };
  /** Versions saved for this org; custom ones (learned, or with the stadgar's items) can be re-adopted. */
  formats: { id: string; kind: FormatKind; isDefault: boolean; createdAt: string; custom?: boolean; requiredCount?: number }[];
  /** Admins: hidden `orgId`, `choice` = a standard kind or `id:<profile id>`. */
  changeFormat?: FormAction;
  /** The Google Picker is configured: admins can pick the meeting folder. */
  pickerEnabled?: boolean;
}

const STANDARD_KINDS = ["veckomote", "styrelseprotokoll", "enkel"] as const;

const dateOf = (iso: string) => iso.slice(0, 10);

/** The org's meeting format: current default, switch (admins), meeting folder, learn a format (B2). */
export function FormatCard({ orgId, current, isAdmin, meetingFolder, formats, changeFormat, pickerEnabled = false }: FormatCardProps) {
  // Custom versions (a learned format, a Styrelseprotokoll with the stadgar's items, an adjusted
  // standard) are offered by id: choosing the bare standard would drop what makes them theirs (R3-I2).
  const custom = formats
    .map((f) => ({ ...f, custom: f.custom ?? f.kind === "learned", requiredCount: f.requiredCount ?? 0 }))
    .filter((f) => f.custom);
  const currentRow = current.id ? custom.find((f) => f.id === current.id) : undefined;
  const required = current.profile?.requiredItems ?? [];
  const selected = currentRow ? `id:${currentRow.id}` : current.kind === "learned" ? "" : current.kind;
  return (
    <Panel title="Mötesformat" titleId="format-title">
      <div className="stack stack--3">
        <p>
          Mötesformat: <strong>{currentRow ? formatLabel(currentRow) : current.name}</strong>
        </p>
        {required.length > 0 && (
          <div className="stack stack--1">
            <p className="subtle">Punkter som stadgarna kräver ({required.length}), med på varje dagordning:</p>
            <ul className="hint">
              {required.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {isAdmin && changeFormat && (
          <form action={changeFormat} className="stack stack--2">
            <input type="hidden" name="orgId" value={orgId} />
            <label className="label" htmlFor="format-choice">
              Byt format
            </label>
            <select id="format-choice" name="choice" className="input" defaultValue={selected}>
              {selected === "" && (
                <option value="" disabled>
                  {FORMAT_NAMES.learned}
                </option>
              )}
              {STANDARD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FORMAT_NAMES[k]}
                </option>
              ))}
              {custom.map((f) => (
                <option key={f.id} value={`id:${f.id}`}>
                  {formatLabel(f)}
                  {f.isDefault ? " · används nu" : ""}
                </option>
              ))}
            </select>
            <div>
              <SubmitButton variant="secondary" pendingLabel="Byter…">
                Byt
              </SubmitButton>
            </div>
          </form>
        )}
        {isAdmin && current.profile && <CustomizeFormat orgId={orgId} current={current.profile} />}
        <div className="stack stack--2">
          <p className="subtle">Mötesmapp: {meetingFolder.id ? "vald" : "inte vald"}</p>
          {isAdmin &&
            (pickerEnabled ? (
              <MeetingFolderButton orgId={orgId} hasFolder={meetingFolder.id !== null} />
            ) : (
              <p className="hint">Google-väljaren är inte inställd än.</p>
            ))}
        </div>
        {isAdmin &&
          (pickerEnabled ? (
            <>
              <LearnFormat orgId={orgId} />
              <StadgarFormat orgId={orgId} current={current.profile} />
            </>
          ) : (
            <div>
              <Button variant="ghost" disabled>
                Lär Simon Says ert format
              </Button>
              <p className="hint">Google-väljaren är inte inställd än.</p>
            </div>
          ))}
      </div>
    </Panel>
  );
}
