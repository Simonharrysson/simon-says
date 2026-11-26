import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PublicShell } from "@/components/views/PublicShell";
import { UnsubscribeView, type UnsubscribeViewProps } from "@/components/views/UnsubscribeView";
import { lookupUnsubscribe, unsubscribe } from "@/lib/summaries/unsubscribe";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Avsluta prenumeration", robots: { index: false } };

async function unsubscribeAction(form: FormData): Promise<void> {
  "use server";
  const token = form.get("t")?.toString() ?? "";
  const ok = await unsubscribe(token);
  redirect(ok ? `/sammanfattning/avsluta?t=${encodeURIComponent(token)}` : "/sammanfattning/avsluta");
}

/** The summary e-mail's "Avsluta prenumeration" (0037). No sign-in: the signed link is the proof. */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  const target = await lookupUnsubscribe(t);
  const props: UnsubscribeViewProps = !target
    ? { state: "invalid" }
    : target.unsubscribed
      ? { state: "done", orgName: target.orgName }
      : { state: "confirm", token: t!, orgName: target.orgName, unsubscribe: unsubscribeAction };
  return (
    <PublicShell signedIn={false} noLoginLink>
      <UnsubscribeView {...props} />
    </PublicShell>
  );
}
