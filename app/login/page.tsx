import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { LoginView } from "@/components/views/LoginView";
import { PublicShell } from "@/components/views/PublicShell";
import { safeNextPath } from "@/lib/next-path";
import { signInWithGoogle } from "./actions";
import { toLocale } from "@/lib/i18n/config";
import { publicMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("login");
  return publicMetadata({ title: t("metaTitle"), description: t("metaDescription"), path: "/login", locale: toLocale(await getLocale()) });
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ fel?: string; next?: string }> }) {
  const { fel, next } = await searchParams;
  const safeNext = safeNextPath(next);
  return (
    <PublicShell signedIn={false} noLoginLink>
      <LoginView error={fel} next={safeNext} signIn={signInWithGoogle} joining={safeNext.startsWith("/join/")} />
    </PublicShell>
  );
}
