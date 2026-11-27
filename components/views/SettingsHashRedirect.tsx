"use client";

import { useEffect } from "react";
import { HASH_SECTIONS } from "@/lib/orgs/tabs";

/**
 * Links from before the Inställningar tab (summary e-mails: `/orgs/<id>#sammanfattning`) pointed
 * at the settings' place on the one long page; the hash never reaches the server, so the Möten
 * tab forwards them to the section that holds that setting now (`&del=`). Admins only (members
 * have no Inställningar).
 */
export function SettingsHashRedirect({ href }: { href: string }) {
  useEffect(() => {
    const section = HASH_SECTIONS[window.location.hash];
    if (section) window.location.replace(`${href}&del=${section}`);
  }, [href]);
  return null;
}
