import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/db/ids";
import { myRole } from "@/lib/db/orgs";
import { getEnv } from "@/lib/env";
import { translator, type Translator } from "@/lib/i18n/translator";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { BatchClient } from "./batch";

// Shared by the import job routes: the admin check, error replies, the batch client.

export const noStore = { "cache-control": "no-store" };
export const fail = (error: string, status: number, message: string) => NextResponse.json({ error, message }, { status, headers: noStore });

type ServerDb = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/** The signed-in admin of org `id`, or the reply to send. */
export async function requireAdmin(id: string, t: Translator = translator()): Promise<{ ok: true; db: ServerDb; userId: string } | { ok: false; reply: NextResponse }> {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { ok: false, reply: fail("unauthenticated", 401, t("api.unauthenticated")) };
  if (!isUuid(id)) return { ok: false, reply: fail("not_found", 404, t("api.orgNotFound")) };
  const role = await myRole(db, id);
  if (!role) return { ok: false, reply: fail("not_found", 404, t("api.orgNotFound")) };
  if (role !== "admin") return { ok: false, reply: fail("forbidden", 403, t("api.historyAdminsOnly")) };
  return { ok: true, db, userId: user.id };
}

let client: BatchClient | undefined;
/** The SDK client for the Message Batches API (create, poll, results, cancel). */
export function batchClient(): BatchClient {
  // No SDK retries: a create that timed out after Anthropic accepted it must not become a second
  // batch. Polls are repeated by the cron and the status request anyway.
  client ??= new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 0 }) as unknown as BatchClient;
  return client;
}
