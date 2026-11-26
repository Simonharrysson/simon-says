import { notFound, redirect } from "next/navigation";
import { isUuid } from "@/lib/db/ids";

export const dynamic = "force-dynamic";

/**
 * Where Google's consent for the protocol import returns (a query-free path, so it passes the
 * same `next` check as the login): opens the Översikt with the import open, passing on whether
 * the admin gave read access (`drive=ok`), said no (`nej`) or it failed (`fel`).
 */
export default async function ProtocolImportReturn({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ drive?: string }>;
}) {
  const { id } = await params;
  const { drive } = await searchParams;
  if (!isUuid(id)) notFound();
  const result = drive === "ok" || drive === "nej" || drive === "fel" ? `&drive=${drive}` : "";
  redirect(`/orgs/${id}?flik=oversikt&import=1${result}`);
}
