import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ConnectMessage } from "@/components/views/ConnectView";
import { PublicShell } from "@/components/views/PublicShell";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("connect"))("metaTitle"), robots: { index: false } };
}

/** A connection that could not start (unknown client or redirect address): never sent back to the client. */
export default async function ConnectErrorPage({ searchParams }: { searchParams: Promise<{ fel?: string }> }) {
  const { fel } = await searchParams;
  return (
    <PublicShell signedIn={false}>
      <ConnectMessage kind={fel === "adress" ? "errorRedirect" : "errorClient"} />
    </PublicShell>
  );
}
