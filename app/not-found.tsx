import { ButtonLink } from "@/components/ui/button";
import { IconArrowLeft } from "@/components/ui/icons";
import { PublicShell } from "@/components/views/PublicShell";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function NotFound() {
  // Signed in: the header offers the app, not "Logga in" (a 404 status page rendered by the proxy).
  const {
    data: { user },
  } = await (await createSupabaseServerClient()).auth.getUser().catch(() => ({ data: { user: null } }));
  return (
    <PublicShell signedIn={Boolean(user)}>
      <div className="mx-auto w-full px-gutter max-w-[40rem] flex flex-col items-start gap-4 py-[clamp(2rem,8vh,6rem)]">
        <p className="font-mono text-sm text-ink-3">404</p>
        <h1 className="text-2xl">Här finns ingenting</h1>
        <p className="text-ink-2">
          Sidan har flyttats, raderats eller så har du inte tillgång till den. Är det en förening kan en admin
          bjuda in dig.
        </p>
        <ButtonLink href="/" icon={<IconArrowLeft />}>
          Till startsidan
        </ButtonLink>
      </div>
    </PublicShell>
  );
}
