import { ViewTransition, type ReactNode } from "react";
import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { AppNav } from "@/components/views/AppNav";
import { RefreshOnBack } from "@/components/views/RefreshOnBack";
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
      {/* Link navigations (AppLink tags them "nav") crossfade the page under a still header.
          Tab switches ("tab") don't animate here: their panel swap is a sync render, so
          OrgTabsShell fades the panel with CSS. Refreshes, server actions and back/forward don't
          animate. CSS: app/globals.css "View transitions". */}
      <ViewTransition default="none" update={{ nav: "page-nav", default: "none" }}>
        <main id="innehall" className="flex-1 pt-8 pb-16">
          {children}
        </main>
      </ViewTransition>
      <SiteFooter />
      <RefreshOnBack />
    </>
  );
}
