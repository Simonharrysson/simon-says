import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PublicShell } from "@/components/views/PublicShell";
import { SignedInAgain } from "@/components/live/SignedInAgain";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("login"))("signedInAgainMetaTitle"), robots: { index: false, follow: false } };
}

/**
 * Where "Logga in igen" on the live page lands (U8): a sign-in in a new tab, so the meeting tab
 * keeps its state. This page tells the other tab to send what waits, and says "close me".
 */
export default function SignedInPage() {
  return (
    <PublicShell signedIn noLoginLink>
      <div className="mx-auto w-full max-w-[36rem] px-gutter pt-[clamp(1.5rem,8vh,5rem)] pb-12">
        <SignedInAgain />
      </div>
    </PublicShell>
  );
}
