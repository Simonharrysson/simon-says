import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { getOrg, myRole } from "@/lib/db/orgs";
import { linkLikeName } from "@/lib/invites/email";
import { INVITE_LIMITS, LINK_NAME_MESSAGE, parseEmails } from "@/lib/invites/rules";
import { inviterNameFor, listInvites, sendInvites, type AddressResult } from "@/lib/invites/send";
import { emailPrefsUrl, listUnsubscribeHeaders } from "@/lib/email/token";
import { defaultMailer } from "@/lib/mail";
import { appOrigin } from "@/lib/origin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// Up to 10 addresses per request (the form sends longer lists in turns), two at a time; sends
// stop starting after 40 s, so the request ends inside this.
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });
const FORBIDDEN = "Bara administratörer kan bjuda in via mejl.";

type Gate = { ok: true; userId: string; email: string | null; metadata: Record<string, unknown> | undefined } | { ok: false; res: NextResponse };

/** Signed in, a real förening, and its admin (checked with the user's own client: RLS). */
async function adminGate(id: string): Promise<Gate> {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { ok: false, res: fail("unauthenticated", 401, "Du är inte inloggad. Logga in och försök igen.") };
  if (!isUuid(id)) return { ok: false, res: fail("not_found", 404, "Föreningen finns inte.") };
  const role = await myRole(db, id);
  if (!role) return { ok: false, res: fail("not_found", 404, "Föreningen finns inte.") };
  if (role !== "admin") return { ok: false, res: fail("forbidden", 403, FORBIDDEN) };
  return { ok: true, userId: user.id, email: user.email ?? null, metadata: user.user_metadata };
}

/** The förening's sent invites (admins). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await adminGate(id);
  if (!gate.ok) return gate.res;
  try {
    return NextResponse.json({ invites: await listInvites(supabaseAdmin(), id) }, { headers: noStore });
  } catch (err) {
    console.error(`invites list: ${(err as Error).message}`.slice(0, 200));
    return fail("list_failed", 500, "Inbjudningarna kunde inte läsas. Ladda om sidan.");
  }
}

/**
 * Sends the invite e-mail. Body `{ emails: string | string[], resend?: boolean }`: addresses as
 * typed (parsed again here); `resend` for "Skicka igen" / "Försök igen". Answers per address:
 * `{ results: [{ email, result }], invites }`. Limits live in the database (0038).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await adminGate(id);
  if (!gate.ok) return gate.res;

  const body = (await request.json().catch(() => null)) as { emails?: unknown; resend?: unknown } | null;
  const raw = typeof body?.emails === "string" ? body.emails : Array.isArray(body?.emails) && body.emails.every((e) => typeof e === "string") ? (body.emails as string[]).join("\n") : null;
  if (raw === null || raw.length > 20_000) return fail("bad_request", 400, "Skriv en eller flera e-postadresser.");
  const parsed = parseEmails(raw);
  if (parsed.valid.length === 0 && parsed.invalid.length === 0) return fail("bad_request", 400, "Skriv en eller flera e-postadresser.");
  if (parsed.valid.length > INVITE_LIMITS.perRequest) {
    return fail("too_many", 400, `Högst ${INVITE_LIMITS.perRequest} adresser åt gången.`);
  }

  const db = await createSupabaseServerClient();
  const admin = supabaseAdmin();
  try {
    const org = await getOrg(db, id);
    if (!org) return fail("not_found", 404, "Föreningen finns inte.");
    const { data: person } = await admin.from("people").select("name").eq("org_id", id).eq("member_user_id", gate.userId).maybeSingle();
    const inviterName = inviterNameFor(person?.name as string | undefined, gate.metadata);
    // Mail clients link anything that looks like a domain: never carry one in our mail (I1).
    const linkName = linkLikeName(inviterName, org.name);
    if (linkName) return fail(`name_link_${linkName}`, 400, LINK_NAME_MESSAGE[linkName]);
    const results: AddressResult[] = parsed.invalid.map((email) => ({ email, result: "invalid" as const }));
    if (parsed.valid.length > 0) {
      results.push(
        ...(await sendInvites(
          {
            orgId: id,
            userId: gate.userId,
            inviterName,
            inviterEmail: gate.email,
            orgName: org.name,
            // The link as it is now: a rotated code must not go out in an old e-mail.
            inviteUrl: `${appOrigin()}/join/${org.invite_code}`,
            emails: parsed.valid,
            resend: body?.resend === true,
          },
          {
            db: admin,
            mailer: defaultMailer(),
            links: { prefsUrl: (email) => emailPrefsUrl(email, "invite"), headers: (email) => listUnsubscribeHeaders(email, "invite") },
          },
        )),
      );
    }
    return NextResponse.json({ results, invites: await listInvites(admin, id) }, { headers: noStore });
  } catch (err) {
    if ((err as { code?: string }).code === "42501") return fail("forbidden", 403, FORBIDDEN);
    console.error(`invites send: ${(err as Error).message}`.slice(0, 200));
    return fail("send_failed", 500, "Inbjudningarna kunde inte skickas. Försök igen.");
  }
}
