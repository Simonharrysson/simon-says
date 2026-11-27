import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConnectMessage, ConnectView } from "@/components/views/ConnectView";
import { PublicShell } from "@/components/views/PublicShell";
import { mcpConfigured, mcpStore } from "@/lib/mcp/deps";
import { looksLike } from "@/lib/mcp/oauth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { approveConnection, denyConnection } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("connect"))("metaTitle"), robots: { index: false } };
}

/** "Ge Claude tillgång till dina möten i Simon Says": the consent for one stored authorization request. */
export default async function ConnectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!looksLike("request", id)) return shell(<ConnectMessage kind="expired" />);
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/koppla/${id}`)}`);
  const store = mcpStore();
  const req = await store.getRequest(id);
  if (!req || Date.parse(req.expires_at) <= Date.now()) return shell(<ConnectMessage kind="expired" />, true);
  const client = await store.getClient(req.client_id);
  if (!client) return shell(<ConnectMessage kind="expired" />, true);
  return shell(
    <ConnectView
      requestId={id}
      clientName={client.client_name}
      host={new URL(req.redirect_uri).host}
      email={user.email ?? ""}
      allowed={mcpConfigured()}
      approve={approveConnection}
      deny={denyConnection}
    />,
    true,
  );
}

const shell = (children: React.ReactNode, signedIn = false) => <PublicShell signedIn={signedIn}>{children}</PublicShell>;
