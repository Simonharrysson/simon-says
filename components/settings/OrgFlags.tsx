"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Check } from "@/components/ui/Field";
import { setOrgFlagAction, type OrgFlagName } from "@/app/(app)/orgs/settings-actions";
import { SaveState, useSavedValue } from "./SaveState";

// The förening's three switches (share_transcript, show_on_status, require_task_fields), in two
// sections. Each saves on change, that column only (`setOrgFlagAction`), one save at a time.

export interface OrgFlagsOrg {
  id: string;
  share_transcript: boolean;
  show_on_status: boolean;
  require_task_fields?: boolean;
  /** 0063: invite attendees without an account after a meeting (default on). */
  invite_attendees?: boolean;
}

const FlagsContext = createContext<OrgFlagsOrg | null>(null);

export function OrgFlagsProvider({ org, children }: { org: OrgFlagsOrg; children: ReactNode }) {
  return <FlagsContext.Provider value={org}>{children}</FlagsContext.Provider>;
}

/** One switch, saved on change, with its quiet "Sparat" on the right. */
export function OrgFlag({ name, id, title, children }: { name: OrgFlagName; id: string; title: ReactNode; children?: ReactNode }) {
  const org = useContext(FlagsContext);
  if (!org) throw new Error("OrgFlag outside OrgFlagsProvider");
  const server = name === "require_task_fields" || name === "invite_attendees" ? org[name] !== false : org[name];
  const flag = useSavedValue(server, async (value) => {
    const r = await setOrgFlagAction(org.id, name, value);
    return r.ok ? null : r.message;
  });
  return (
    <div className="flex items-start justify-between gap-4 max-[30rem]:flex-col max-[30rem]:gap-1">
      <Check id={id} checked={flag.value} onCheckedChange={(v) => flag.change(v === true)} title={title}>
        {children}
      </Check>
      <SaveState status={flag.status} className="flex-none max-[30rem]:pl-7" />
    </div>
  );
}
