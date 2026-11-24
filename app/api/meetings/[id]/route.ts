import { NextResponse, type NextRequest } from "next/server";
import { deleteMeeting } from "@/lib/db/orgs";
import { isUuid } from "@/lib/db/ids";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const status = { deleted: 200, not_found: 404, forbidden: 403, name_mismatch: 400 } as const;

/** Delete a meeting with its transcript data and notes. Starter or org admin. Doc stays in Drive. */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const result = await deleteMeeting(supabase, id);
  if (result === "deleted") return NextResponse.json({ deleted: true });
  return NextResponse.json({ error: result }, { status: status[result] });
}
