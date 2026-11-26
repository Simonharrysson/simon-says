import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { getTranslations } from "next-intl/server";
import { PublicShell } from "@/components/views/PublicShell";
import { StatusView, type StatusData } from "@/components/views/StatusView";
import { getEnv } from "@/lib/env";
import { loadStatus } from "@/lib/status";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("status"))("metaTitle") };
}

// Public, no auth. The page renders per request (the root layout reads the language cookie), so
// the numbers are cached instead: read with the service role at most once a minute, shared by
// every visitor and both languages (they hold no copy).
const cachedStatus = unstable_cache(
  async (killSwitch: boolean): Promise<StatusData> => loadStatus(supabaseAdmin(), killSwitch),
  ["status-page"],
  { revalidate: 60, tags: ["status"] },
);

export default async function StatusPage() {
  // A failed load throws (error page) instead of rendering an empty state: a thrown load is not
  // cached, so a failure can't stick for the 60 s window.
  const data: StatusData = await cachedStatus(getEnv().KILL_SWITCH);
  return (
    <PublicShell signedIn={false}>
      <StatusView data={data} />
    </PublicShell>
  );
}
