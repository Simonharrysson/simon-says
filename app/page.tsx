import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { signInWithGoogle } from "@/app/login/actions";
import { LandingView } from "@/components/views/LandingView";
import { PublicShell } from "@/components/views/PublicShell";
import { toLocale } from "@/lib/i18n/config";
import { publicMetadata, softwareApplicationJsonLd } from "@/lib/seo";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("landing");
  return publicMetadata({ title: t("metaTitle"), description: t("metaDescription"), path: "/", locale: toLocale(await getLocale()), absoluteTitle: true });
}

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const t = await getTranslations("landing");

  return (
    <PublicShell signedIn={Boolean(user)} flush>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: softwareApplicationJsonLd(t("metaDescription")) }} />
      <LandingView user={user ? { email: user.email ?? "", id: user.id } : null} signIn={signInWithGoogle} />
    </PublicShell>
  );
}
