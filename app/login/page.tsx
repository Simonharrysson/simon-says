import type { Metadata } from "next";
import { LoginView } from "@/components/views/LoginView";
import { PublicShell } from "@/components/views/PublicShell";
import { safeNextPath } from "@/lib/next-path";
import { signInWithGoogle } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Logga in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ fel?: string; next?: string }> }) {
  const { fel, next } = await searchParams;
  const safeNext = safeNextPath(next);
  return (
    <PublicShell signedIn={false} noLoginLink>
      <LoginView error={fel} next={safeNext} signIn={signInWithGoogle} joining={safeNext.startsWith("/join/")} />
    </PublicShell>
  );
}
