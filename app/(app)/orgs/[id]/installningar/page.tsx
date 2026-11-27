import { notFound, redirect } from "next/navigation";
import { isUuid } from "@/lib/db/ids";
import { orgTabHref } from "@/lib/orgs/tabs";

/**
 * `/orgs/<id>/installningar` → the förening page's Inställningar tab. A plain path, so it can be
 * a return address where only paths pass (`safeNextPath`: "Koppla kalender" in Inställningar
 * comes back here with `?kalender=…`, the sign-in `next`). The result codes and the section
 * (`?del=`) go along.
 */
export default async function OrgSettingsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const sp = await searchParams;
  const keep = new URLSearchParams();
  for (const key of ["kalender", "fel", "klart", "del"]) {
    const v = sp[key];
    if (typeof v === "string" && /^[a-z_-]{1,40}$/.test(v)) keep.set(key, v);
  }
  const rest = keep.toString();
  redirect(`${orgTabHref(id, "installningar")}${rest ? `&${rest}` : ""}`);
}
