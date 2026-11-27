import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { HomeColumn, HomeView } from "@/components/home/HomeView";
import { PageHeader } from "@/components/ui/PageHeader";
import { SkeletonPanel } from "@/components/ui/PageSkeleton";
import { Skeleton } from "@/components/ui/skeleton";
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
 * Föreningar instead, where they create or join one. The title is in the first HTML; the
 * tasks and meetings stream in under it.
 */
export default async function HomePage() {
  const t = await getTranslations("home");
  return (
    <HomeColumn>
      <PageHeader title={t("title")} />
      <Suspense fallback={<HomeSkeleton />}>
        <HomeContent />
      </Suspense>
    </HomeColumn>
  );
}

async function HomeContent() {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login?next=/hem");
  const data = await loadHome(db, user.id);
  if (data.brandNew) redirect("/orgs");
  return <HomeView bare tasks={data.tasks} recent={data.recent} unlinked={data.unlinked} email={user.email ?? null} docs={data.docs} today={stockholmDay(new Date())} />;
}

/** Mina uppgifter (heading, intro, filters, list) and Senaste mötena while they load. */
function HomeSkeleton() {
  return (
    <>
      <div className="flex flex-col gap-4" aria-hidden="true">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-4 w-[min(30rem,90%)]" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-28 rounded-md" />
        </div>
        <SkeletonPanel rows={3} titleWidth="w-28" />
      </div>
      <div className="mt-6">
        <SkeletonPanel rows={4} titleWidth="w-36" />
      </div>
    </>
  );
}
