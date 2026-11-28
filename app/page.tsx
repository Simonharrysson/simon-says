import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { signInWithGoogle } from "@/app/login/actions";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { SiteFooter } from "@/components/ui/SiteFooter";
import { FAQ_KEYS, LandingView } from "@/components/views/LandingView";
import { toLocale } from "@/lib/i18n/config";
import { faqJsonLd, publicMetadata, softwareApplicationJsonLd } from "@/lib/seo";
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
  // The FAQ answers as plain text: rich tags keep their words, lose the link.
  const faq = FAQ_KEYS.map((n) => ({ question: t(`faq.q${n}`), answer: t.markup(`faq.a${n}`, { link: (chunks) => chunks }) }));

  return (
    <>
      <LandingHeader signedIn={Boolean(user)} signIn={signInWithGoogle} />
      <main id="innehall" className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: softwareApplicationJsonLd(t("metaDescription")) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: faqJsonLd(faq) }} />
        <LandingView user={user ? { email: user.email ?? "", id: user.id } : null} signIn={signInWithGoogle} />
      </main>
      <SiteFooter />
    </>
  );
}
