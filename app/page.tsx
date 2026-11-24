import { signOut } from "@/app/login/actions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main>
      <h1>Simon Says</h1>
      <p>Livenoteringar från möten, direkt i Google Docs. Under uppbyggnad.</p>
      {user ? (
        <>
          <p>
            Inloggad som {user.email}. <a href="/orgs">Dina organisationer</a>
          </p>
          <form action={signOut}>
            <button type="submit">Logga ut</button>
          </form>
        </>
      ) : (
        <p>
          <a href="/login">Logga in</a>
        </p>
      )}
    </main>
  );
}
