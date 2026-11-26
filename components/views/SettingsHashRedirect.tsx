"use client";

import { useEffect } from "react";

/** The settings' anchors: on the Möten tab they mean an old link to the one long page. */
const SETTINGS_HASHES = ["#installningar", "#sammanfattning", "#kalender", "#om-oss", "#styrelsen", "#bjud-in"];

/**
 * Links from before the Inställningar tab (summary e-mails: `/orgs/<id>#installningar`) pointed
 * at the settings' place on the one long page; the hash never reaches the server, so the Möten
 * tab forwards them here, keeping the hash. Admins only (members have no Inställningar).
 */
export function SettingsHashRedirect({ href }: { href: string }) {
  useEffect(() => {
    const hash = window.location.hash;
    if (SETTINGS_HASHES.includes(hash)) window.location.replace(`${href}${hash}`);
  }, [href]);
  return null;
}
