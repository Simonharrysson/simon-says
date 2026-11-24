import { NextResponse, type NextRequest } from "next/server";
import { deleteOrg } from "@/lib/db/orgs";
import { isUuid } from "@/lib/db/ids";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const status = { deleted: 200, not_found: 404, forbidden: 403, name_mismatch: 400 } as const;

/**
 * Delete an org and everything under it. Body: `{ "confirmName": "<the org's exact name>" }`.
 * Admins only (RLS). Google Docs are left in Drive.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { confirmName?: unknown } | null;
  const confirmName = typeof body?.confirmName === "string" ? body.confirmName : "";

  const result = await deleteOrg(supabase, id, confirmName);
  if (result === "deleted") return NextResponse.json({ deleted: true });
  return NextResponse.json({ error: result }, { status: status[result] });
}
