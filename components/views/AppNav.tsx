"use client";

import { usePathname } from "next/navigation";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { navLinkClass } from "@/components/ui/SiteHeader";

/**
 * Top-rail links for the logged-in area. Client only for aria-current. On phones the email
 * and Logga ut drop out (Logga ut is also on the Konto page), so the rail never scrolls sideways.
 */
export function AppNav({ email, signOut }: { email: string; signOut: FormAction }) {
  const path = usePathname() ?? "";
  const current = (prefix: string) => (path === prefix || path.startsWith(`${prefix}/`) ? "page" : undefined);
  return (
    <>
      <a className={navLinkClass} href="/privat" aria-current={current("/privat")}>
        Privat
      </a>
      <a className={navLinkClass} href="/orgs" aria-current={current("/orgs")}>
        Föreningar
      </a>
      <a className={navLinkClass} href="/installningar" aria-current={current("/installningar")}>
        Konto
      </a>
      {email && (
        <span className="max-w-[14rem] truncate text-xs text-ink-3 max-md:hidden" title={email}>
          {email}
        </span>
      )}
      <form action={signOut} className="max-[30rem]:hidden">
        <SubmitButton variant="ghost" size="sm" pendingLabel="Loggar ut…">
          Logga ut
        </SubmitButton>
      </form>
    </>
  );
}
