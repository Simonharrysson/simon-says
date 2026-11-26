import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { LOGO_BUCKET, LOGO_MAX_BYTES, logoPath, sniffImage } from "@/lib/orgs/logo";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// The förening's logo (onboarding step 1, 0035). Everything runs as the signed-in user, so the
// storage policies decide too: members read their förening's logo, admins write it. The browser
// sends the square it cropped and resized; the route checks the bytes (PNG/JPEG/WebP only).

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

async function admin(id: string) {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { db, res: fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.") };
  if (!isUuid(id)) return { db, res: fail("not_found", 404, "Föreningen finns inte.") };
  const role = await myRole(db, id);
  if (!role) return { db, res: fail("not_found", 404, "Föreningen finns inte.") };
  if (role !== "admin") return { db, res: fail("forbidden", 403, "Bara administratörer kan byta logga.") };
  return { db, res: null };
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return new NextResponse(null, { status: 404 });
  const db = await createSupabaseServerClient();
  const { data, error } = await db.storage.from(LOGO_BUCKET).download(logoPath(id));
  if (error || !data) return new NextResponse(null, { status: 404, headers: noStore });
  const bytes = new Uint8Array(await data.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) return new NextResponse(null, { status: 404, headers: noStore });
  return new NextResponse(bytes, {
    headers: {
      "content-type": type,
      // The URL carries the version (?v=): a new logo is a new URL. Private: members only.
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, res } = await admin(id);
  if (res) return res;
  const form = await request.formData().catch(() => null);
  const file = form?.get("logo");
  if (!(file instanceof Blob)) return fail("bad_request", 400, "Välj en bild.");
  if (file.size > LOGO_MAX_BYTES) return fail("too_large", 413, "Bilden är för stor (max 1 MB).");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) return fail("unsupported_type", 400, "Välj en PNG-, JPEG- eller WebP-bild.");

  const { error } = await db.storage.from(LOGO_BUCKET).upload(logoPath(id), bytes, { contentType: type, upsert: true, cacheControl: "60" });
  if (error) {
    console.error(`logo: upload: ${error.message}`.slice(0, 200));
    return fail("save_failed", 500, "Loggan kunde inte sparas. Försök igen.");
  }
  const updatedAt = new Date().toISOString();
  const { error: orgError } = await db.from("orgs").update({ logo_updated_at: updatedAt }).eq("id", id);
  if (orgError) {
    console.error(`logo: org: ${orgError.message}`.slice(0, 200));
    return fail("save_failed", 500, "Loggan kunde inte sparas. Försök igen.");
  }
  return NextResponse.json({ updatedAt }, { headers: noStore });
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, res } = await admin(id);
  if (res) return res;
  const { error } = await db.from("orgs").update({ logo_updated_at: null }).eq("id", id);
  if (error) return fail("save_failed", 500, "Loggan kunde inte tas bort. Försök igen.");
  const { error: rm } = await db.storage.from(LOGO_BUCKET).remove([logoPath(id)]);
  if (rm) console.error(`logo: remove: ${rm.message}`.slice(0, 200));
  return NextResponse.json({ ok: true }, { headers: noStore });
}
