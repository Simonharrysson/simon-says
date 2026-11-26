import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { AccountView } from "@/components/views/AccountView";
import { loadEmailPrefs } from "@/lib/email/prefs";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { saveEmailPrefsAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ditt konto" };

export default async function AccountPage() {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  const emailPrefs = await loadEmailPrefs({ userId: user.id });
  return (
    <AccountView
      email={user.email ?? ""}
      userId={user.id}
      signOut={signOut}
      emailPrefs={emailPrefs}
      saveEmailPrefs={saveEmailPrefsAction}
    />
  );
}
