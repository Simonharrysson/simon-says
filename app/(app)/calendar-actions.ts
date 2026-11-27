"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { myCalendars } from "@/lib/calendar/load";
import { cleanFilter, orgCalendarChoices } from "@/lib/calendar/events";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { deleteCalendarToken } from "@/lib/google/client";
import { CALENDAR_SCOPES } from "@/lib/google/scopes";
import { appOrigin } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getOrg } from "@/lib/db/orgs";

/** Where "Koppla kalender" may return: Inställningar, a förening page or its Inställningar tab (never a query string). */
function backPath(raw: unknown): string {
  const v = typeof raw === "string" ? raw : "";
  if (v === "/installningar") return v;
  const m = v.match(/^\/orgs\/([0-9a-f-]{36})(\/installningar)?$/);
  return m && isUuid(m[1]) ? v : "/installningar";
}

/**
 * "Koppla kalender" (todo #14): Google consent for calendar.readonly, asked only here, never at
 * sign-in. Its own token: identity scopes plus calendar.readonly, WITHOUT include_granted_scopes
 * (so it never carries drive.readonly or drive.file), the user's own account as login_hint.
 * /auth/callback stores it apart (google_calendar_tokens) and returns with `?kalender=…`.
 */
export async function requestCalendarAccess(formData: FormData): Promise<void> {
  const back = backPath(formData.get("back"));
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${appOrigin()}/auth/callback?next=${encodeURIComponent(back)}&atkomst=kalender`,
      scopes: CALENDAR_SCOPES.join(" "),
      queryParams: {
        access_type: "offline",
        prompt: "consent",
        ...(user.email ? { login_hint: user.email } : {}),
      },
    },
  });
  if (error || !data.url) redirect(`${back}?kalender=fel`);
  redirect(data.url);
}

/** "Koppla från": deletes our copy of the calendar token (not revoked at Google; see deleteCalendarToken). */
export async function disconnectCalendar(formData: FormData): Promise<void> {
  const back = backPath(formData.get("back"));
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  try {
    await deleteCalendarToken(user.id);
  } catch (err) {
    console.error("calendar: disconnect failed", (err as Error)?.message);
    redirect(`${back}?kalender=fel`);
  }
  revalidatePath(back);
  redirect(`${back}?kalender=fran`);
}

/**
 * Inställningar → "Mötenas kalender" (admins): the calendar holding the förening's meetings, one
 * of the admin's OWN shared calendars (checked against their list, which also gives its name; never
 * a primary calendar), and an optional title filter. An empty choice clears it. Written with the
 * service role after these checks: authenticated has no update grant on these columns (0046).
 */
export async function saveOrgCalendarAction(formData: FormData): Promise<void> {
  const orgId = formData.get("orgId")?.toString() ?? "";
  const result = await saveOrgCalendar(orgId, formData.get("calendar_id")?.toString() ?? "", formData.get("calendar_filter"));
  if (result === "ok") return;
  if (result === "fel") redirect(`/orgs/${orgId}?fel=kalender`);
  redirect(result);
}

/**
 * Inställningar → Möten's calendar (the settings' save-on-change model): the same save, but the
 * outcome comes back instead of a redirect, so the form says "Sparat" only after it worked.
 */
export async function saveOrgCalendarResult(orgId: string, calendarId: string, filter: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await saveOrgCalendar(orgId, calendarId, filter);
  if (result === "ok") return { ok: true };
  return { ok: false, message: (await getTranslations("org.settings"))("saveFailed") };
}

/** "ok", "fel" (not saved), or where to send someone who may not save here. */
async function saveOrgCalendar(orgId: string, calendarId: string, filter: FormDataEntryValue | null): Promise<"ok" | "fel" | string> {
  if (!isUuid(orgId)) return "/";
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "/login";
  if ((await myRole(supabase, orgId)) !== "admin") return `/orgs/${orgId}`;
  const org = await getOrg(supabase, orgId);
  if (!org || org.kind === "privat") return "/";
  let values: { calendar_id: string | null; calendar_name: string | null; calendar_filter: string | null };
  if (!calendarId) values = { calendar_id: null, calendar_name: null, calendar_filter: null };
  else {
    const mine = await myCalendars(user.id, { fresh: true });
    const picked = orgCalendarChoices(mine ?? []).find((c) => c.id === calendarId);
    if (!picked) return "fel";
    values = { calendar_id: picked.id, calendar_name: picked.name, calendar_filter: cleanFilter(filter) || null };
  }
  const { data, error } = await supabaseAdmin().from("orgs").update(values).eq("id", orgId).select("id");
  if (error || !data?.length) {
    console.error("calendar: saving the org calendar failed", error?.message ?? "no row");
    return "fel";
  }
  revalidatePath(`/orgs/${orgId}`);
  return "ok";
}
