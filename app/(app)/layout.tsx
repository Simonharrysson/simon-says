import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { AppNav } from "@/components/views/AppNav";
import { SiteFooter } from "@/components/ui/SiteFooter";
import { SiteHeader } from "@/components/ui/SiteHeader";
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
      <SiteHeader homeHref="/hem" nav={<AppNav email={user.email ?? ""} signOut={signOut} />} />
      <main id="innehall" className="flex-1 pt-8 pb-16">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
