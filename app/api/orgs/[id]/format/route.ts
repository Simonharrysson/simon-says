import { NextResponse, type NextRequest } from "next/server";
import { apiT } from "@/lib/i18n/api";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { adoptFormat, chooseStandardFormat } from "@/lib/formats/store";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const KINDS = ["veckomote", "styrelseprotokoll", "enkel"] as const;

/** Change the org's meeting format. Body `{ kind }` (a standard format) or `{ profileId }` (an earlier version). Admins only. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = apiT(request);
  const { id } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const role = await myRole(db, id);
  if (!role) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (role !== "admin") return NextResponse.json({ error: t("api.formatAdminsOnly") }, { status: 403 });

  const body = (await request.json().catch(() => null)) as { kind?: unknown; profileId?: unknown } | null;
  try {
    if (typeof body?.profileId === "string") {
      if (!isUuid(body.profileId)) return NextResponse.json({ error: "invalid" }, { status: 400 });
      await adoptFormat(db, id, body.profileId);
      return NextResponse.json({ id: body.profileId });
    }
    const kind = KINDS.find((k) => k === body?.kind);
    if (!kind) return NextResponse.json({ error: "invalid" }, { status: 400 });
    return NextResponse.json({ id: await chooseStandardFormat(db, id, kind) });
  } catch (err) {
    if ((err as { code?: string }).code === "42501") {
      return NextResponse.json({ error: t("api.formatAdminsOnly") }, { status: 403 });
    }
    throw err;
  }
}
