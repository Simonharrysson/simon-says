import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { HomeView } from "@/components/home/HomeView";
import { loadHome } from "@/lib/home/load";
import { stockholmDay } from "@/lib/home/tasks";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("home"))("metaTitle") };
}

/**
 * Hem: the page after sign-in. Mina uppgifter (the user's open tasks in every förening and
 * Privat) and the latest meetings. A brand-new user (no förening, nothing in Privat) goes to
 * Föreningar instead, where they create or join one.
 */
export default async function HomePage() {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login?next=/hem");
  const data = await loadHome(db, user.id);
  if (data.brandNew) redirect("/orgs");
  return <HomeView tasks={data.tasks} recent={data.recent} unlinked={data.unlinked} email={user.email ?? null} docs={data.docs} today={stockholmDay(new Date())} />;
}
