"use client";

import { usePathname } from "next/navigation";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FormAction } from "@/components/ui/ConfirmAction";

/** Top-rail links for the logged-in area. Client only for aria-current. */
export function AppNav({ email, signOut }: { email: string; signOut: FormAction }) {
  const path = usePathname() ?? "";
  const current = (prefix: string) => (path === prefix || path.startsWith(`${prefix}/`) ? "page" : undefined);
  return (
    <>
      <a className="nav-link" href="/orgs" aria-current={current("/orgs")}>
        Organisationer
      </a>
      <a className="nav-link" href="/installningar" aria-current={current("/installningar")}>
        Konto
      </a>
      {email && (
        <span className="nav-email" title={email}>
          {email}
        </span>
      )}
      <form action={signOut}>
        <SubmitButton variant="ghost" size="sm" pendingLabel="Loggar ut…">
          Logga ut
        </SubmitButton>
      </form>
    </>
  );
}
