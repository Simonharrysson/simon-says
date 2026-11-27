"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { Check } from "@/components/ui/Field";
import { SaveState, useSaveState } from "./SaveState";

// The förening's three switches (share_transcript, show_on_status, require_task_fields) live in
// two sections but are saved by one action (`updateOrgAction`), which writes the name and all
// three at once and reads a missing checkbox as off. So one provider holds their latest values:
// each switch sends all three, plus the förening's *saved* name (never a draft being typed).

export type OrgFlagName = "share_transcript" | "show_on_status" | "require_task_fields";
type Flags = Record<OrgFlagName, boolean>;

export interface OrgFlagsOrg {
  id: string;
  name: string;
  share_transcript: boolean;
  show_on_status: boolean;
  require_task_fields?: boolean;
}

const fromOrg = (org: OrgFlagsOrg): Flags => ({
  share_transcript: org.share_transcript,
  show_on_status: org.show_on_status,
  require_task_fields: org.require_task_fields !== false,
});

const FlagsContext = createContext<{ flags: Flags; save: (name: OrgFlagName, value: boolean) => Promise<void> } | null>(null);

export function OrgFlagsProvider({ org, updateOrg, children }: { org: OrgFlagsOrg; updateOrg: FormAction; children: ReactNode }) {
  const server = fromOrg(org);
  const serverKey = JSON.stringify(server);
  const [flags, setFlags] = useState(server);
  const [seen, setSeen] = useState(serverKey);
  // The server's values changed (a save landed, or someone else saved): take them.
  if (seen !== serverKey) {
    setSeen(serverKey);
    setFlags(server);
  }
  const latest = useRef(flags);
  latest.current = flags;

  const save = async (name: OrgFlagName, value: boolean) => {
    const next = { ...latest.current, [name]: value };
    latest.current = next;
    setFlags(next);
    const form = new FormData();
    form.set("orgId", org.id);
    form.set("name", org.name);
    for (const key of Object.keys(next) as OrgFlagName[]) if (next[key]) form.set(key, "on");
    await updateOrg(form);
  };

  return <FlagsContext.Provider value={{ flags, save }}>{children}</FlagsContext.Provider>;
}

/** One switch, saved on change, with its quiet "Sparat" on the right. */
export function OrgFlag({ name, id, title, children }: { name: OrgFlagName; id: string; title: ReactNode; children?: ReactNode }) {
  const ctx = useContext(FlagsContext);
  const { status, run } = useSaveState();
  if (!ctx) throw new Error("OrgFlag outside OrgFlagsProvider");
  return (
    <div className="flex items-start justify-between gap-4 max-[30rem]:flex-col max-[30rem]:gap-1">
      <Check id={id} checked={ctx.flags[name]} onCheckedChange={(v) => void run(() => ctx.save(name, v === true))} title={title}>
        {children}
      </Check>
      <SaveState status={status} className="flex-none max-[30rem]:pl-7" />
    </div>
  );
}
