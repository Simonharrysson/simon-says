import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Logged-in area. Every page below reads data server-side with the user's session. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <>
      <nav>
        <a href="/orgs">Organisationer</a> · {user.email}{" "}
        <form action={signOut} style={{ display: "inline" }}>
          <button type="submit">Logga ut</button>
        </form>
      </nav>
      {children}
    </>
  );
}
