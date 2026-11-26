import type { Metadata } from "next";
import { MailPrefsView } from "@/components/views/MailPrefsView";
import { PublicShell } from "@/components/views/PublicShell";
import { isEmailCategory } from "@/lib/email/categories";
import { loadEmailPrefs } from "@/lib/email/prefs";
import { checkEmailPrefsToken } from "@/lib/email/token";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { saveLinkEmailPrefsAction } from "./actions";

export const dynamic = "force-dynamic";
// The token is in the URL: keep it out of Referer headers and search engines.
export const metadata: Metadata = { title: "Mejl", referrer: "no-referrer", robots: { index: false, follow: false } };

/** The link at the bottom of every user-facing mail. GET only shows; every change is a POST. */
export default async function MailPrefsPage({ searchParams }: { searchParams: Promise<{ t?: string; k?: string }> }) {
  const { t, k } = await searchParams;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  const email = checkEmailPrefsToken(t);
  const prefs = email ? await loadEmailPrefs({ email }) : null;
  return (
    <PublicShell signedIn={Boolean(user)}>
      {!email || !t ? (
        <MailPrefsView state="invalid" />
      ) : !prefs ? (
        <MailPrefsView state="error" />
      ) : (
        <MailPrefsView
          state="ready"
          email={email}
          prefs={prefs}
          save={saveLinkEmailPrefsAction.bind(null, t)}
          highlight={isEmailCategory(k) ? k : undefined}
        />
      )}
    </PublicShell>
  );
}
