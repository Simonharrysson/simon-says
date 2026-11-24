import { signInWithGoogle } from "@/app/login/actions";
import { LandingView } from "@/components/views/LandingView";
import { PublicShell } from "@/components/views/PublicShell";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <PublicShell signedIn={Boolean(user)} flush>
      <LandingView user={user ? { email: user.email ?? "", id: user.id } : null} signIn={signInWithGoogle} />
    </PublicShell>
  );
}
