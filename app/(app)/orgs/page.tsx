import { listMyOrgs } from "@/lib/db/orgs";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createOrgAction } from "./actions";

export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  limit: "Du kan skapa högst två organisationer.",
  invalid: "Ange ett namn (högst 100 tecken).",
  inbjudan: "Inbjudningslänken gäller inte längre.",
  raderad: "Organisationen är raderad.",
};

export default async function OrgsPage({ searchParams }: { searchParams: Promise<{ fel?: string; klart?: string }> }) {
  const { fel, klart } = await searchParams;
  const db = await createSupabaseServerClient();
  const orgs = await listMyOrgs(db);
  const message = (fel && messages[fel]) || (klart && messages[klart]) || null;

  return (
    <main>
      <h1>Organisationer</h1>
      {message && <p role={fel ? "alert" : "status"}>{message}</p>}
      {orgs.length === 0 ? (
        <p>Du är inte med i någon organisation än.</p>
      ) : (
        <ul>
          {orgs.map((org) => (
            <li key={org.id}>
              <a href={`/orgs/${org.id}`}>{org.name}</a> {org.role === "admin" && "(admin)"}
            </li>
          ))}
        </ul>
      )}

      <h2>Skapa organisation</h2>
      <form action={createOrgAction}>
        <label>
          Namn <input name="name" required maxLength={100} />
        </label>{" "}
        <button type="submit">Skapa</button>
      </form>
    </main>
  );
}
