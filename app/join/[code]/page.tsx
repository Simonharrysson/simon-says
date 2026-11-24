import { joinOrgAction } from "@/app/(app)/orgs/actions";
import { inviteOrgName } from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** Invite link. Joining is a POST (button), never a side effect of opening the link. */
export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) {
    return (
      <main>
        <h1>Inbjudan till Simon Says</h1>
        <p>Logga in för att gå med i organisationen.</p>
        <p>
          <a href={`/login?next=${encodeURIComponent(`/join/${code}`)}`}>Logga in med Google</a>
        </p>
      </main>
    );
  }

  const name = CODE.test(code) ? await inviteOrgName(db, code) : null;
  if (!name) {
    return (
      <main>
        <h1>Inbjudan till Simon Says</h1>
        <p role="alert">Inbjudningslänken gäller inte längre. Be om en ny.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Gå med i {name}</h1>
      <form action={joinOrgAction}>
        <input type="hidden" name="code" value={code} />
        <button type="submit">Gå med</button>
      </form>
    </main>
  );
}
