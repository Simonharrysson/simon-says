import { Button } from "@/components/ui/Button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { FORMAT_NAMES } from "@/lib/formats/standard";
import type { FormatKind } from "@/lib/formats/schema";

export interface FormatCardProps {
  orgId: string;
  current: { kind: FormatKind; name: string };
  isAdmin: boolean;
  meetingFolder: { id: string | null };
  /** Earlier versions saved for this org (learned ones can be re-adopted). */
  formats: { id: string; kind: FormatKind; isDefault: boolean; createdAt: string }[];
  /** Admins: hidden `orgId`, `choice` = a standard kind or `id:<profile id>`. */
  changeFormat?: FormAction;
}

const STANDARD_KINDS = ["veckomote", "styrelseprotokoll", "enkel"] as const;

const dateOf = (iso: string) => iso.slice(0, 10);

/** The org's meeting format: current default, switch (admins), meeting folder, learn-a-format placeholder. */
export function FormatCard({ orgId, current, isAdmin, meetingFolder, formats, changeFormat }: FormatCardProps) {
  const learned = formats.filter((f) => f.kind === "learned");
  return (
    <Panel title="Mötesformat" titleId="format-title">
      <div className="stack stack--3">
        <p>
          Mötesformat: <strong>{current.name}</strong>
        </p>
        {isAdmin && changeFormat && (
          <form action={changeFormat} className="stack stack--2">
            <input type="hidden" name="orgId" value={orgId} />
            <label className="label" htmlFor="format-choice">
              Byt format
            </label>
            <select id="format-choice" name="choice" className="input" defaultValue={current.kind === "learned" ? "" : current.kind}>
              {current.kind === "learned" && (
                <option value="" disabled>
                  {FORMAT_NAMES.learned}
                </option>
              )}
              {STANDARD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FORMAT_NAMES[k]}
                </option>
              ))}
              {learned.map((f) => (
                <option key={f.id} value={`id:${f.id}`}>
                  {FORMAT_NAMES.learned} ({dateOf(f.createdAt)}){f.isDefault ? " · används nu" : ""}
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
        <p className="subtle">Mötesmapp: {meetingFolder.id ? "vald" : "inte vald"}</p>
        {isAdmin && (
          <div>
            <Button variant="ghost" disabled>
              Lär Simon Says ert format
            </Button>
            <p className="hint">Kommer snart.</p>
          </div>
        )}
      </div>
    </Panel>
  );
}
