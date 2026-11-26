import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LoginView } from "@/components/views/LoginView";
import { PublicShell } from "@/components/views/PublicShell";
import { safeNextPath } from "@/lib/next-path";
import { signInWithGoogle } from "./actions";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("login"))("metaTitle") };
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
