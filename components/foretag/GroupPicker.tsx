"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Check } from "@/components/ui/Field";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

export interface ForetagChoice {
  groupId: string | null;
  private: boolean;
}

const WHOLE = "__whole";

/**
 * Before a Företag meeting (the live page's consent step, where a förening picks its agenda):
 * who the meeting is for and whether it is a Privat möte, with one line saying who will see it.
 * The default is the starter's own group (the safe side).
 */
export function GroupPicker({
  groups,
  initialGroupId,
  onChange,
  disabled,
}: {
  /** Active groups in tree order, with their depth. */
  groups: { id: string; name: string; depth: number }[];
  initialGroupId: string | null;
  onChange: (choice: ForetagChoice) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("foretag.picker");
  const id = useId();
  const [group, setGroup] = useState<string>(initialGroupId && groups.some((g) => g.id === initialGroupId) ? initialGroupId : WHOLE);
  const [priv, setPriv] = useState(false);

  useEffect(() => {
    onChange({ groupId: group === WHOLE ? null : group, private: priv });
  }, [group, priv, onChange]);

  const name = groups.find((g) => g.id === group)?.name;
  const sees = priv ? t("seesPrivate") : group === WHOLE ? t("seesWhole") : t("seesGroup", { group: name ?? "" });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-group`}>{t("label")}</Label>
        <NativeSelect id={`${id}-group`} value={group} onChange={(e) => setGroup(e.target.value)} disabled={disabled}>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {`${" ".repeat(g.depth)}${g.name}`}
            </option>
          ))}
          <option value={WHOLE}>{t("whole")}</option>
        </NativeSelect>
      </div>
      <Check id={`${id}-private`} title={t("private")} checked={priv} onCheckedChange={(on) => setPriv(on === true)} disabled={disabled}>
        {t("privateHint")}
      </Check>
      <p className="text-sm text-ink-2 transition-opacity duration-150" aria-live="polite">
        {sees}
      </p>
    </div>
  );
}
