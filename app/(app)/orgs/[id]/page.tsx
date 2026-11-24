import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isUuid } from "@/lib/db/ids";
import { getOrg, listMeetings, listPeople, myRole } from "@/lib/db/orgs";
import { originFrom } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  addPersonAction,
  deleteMeetingAction,
  deleteOrgAction,
  deletePersonAction,
  renamePersonAction,
  rotateInviteAction,
  updateOrgAction,
} from "../actions";

export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  namn: "Ange ett namn (högst 100 tecken).",
  "mote-forbidden": "Bara den som startade mötet eller en admin kan radera det.",
  "mote-not_found": "Mötet finns inte.",
  "org-name_mismatch": "Namnet stämde inte. Skriv organisationens namn exakt för att radera den.",
  "org-forbidden": "Bara admins kan radera organisationen.",
  mote: "Mötet är raderat.",
};

const statusText: Record<string, string> = {
  live: "pågår",
  ending: "avslutas",
  done: "klart",
  abandoned: "avbrutet",
};

const time = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "short", timeStyle: "short" });

export default async function OrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fel?: string; klart?: string }>;
}) {
  const { id } = await params;
  const { fel, klart } = await searchParams;
  if (!isUuid(id)) notFound();
  const db = await createSupabaseServerClient();
  const org = await getOrg(db, id);
  if (!org) notFound();
  const [role, people, meetings] = await Promise.all([myRole(db, id), listPeople(db, id), listMeetings(db, id)]);
  const isAdmin = role === "admin";
  const inviteUrl = `${originFrom(await headers())}/join/${org.invite_code}`;
  const message = (fel && messages[fel]) || (klart && messages[klart]) || null;

  return (
    <main>
      <h1>{org.name}</h1>
      {message && <p role={fel ? "alert" : "status"}>{message}</p>}

      <section>
        <h2>Bjud in</h2>
        <p>
          Den som öppnar länken och loggar in blir medlem: <code>{inviteUrl}</code>
        </p>
        {isAdmin && (
          <form action={rotateInviteAction}>
            <input type="hidden" name="orgId" value={org.id} />
            <button type="submit">Skapa ny länk (den gamla slutar fungera)</button>
          </form>
        )}
      </section>

      <section>
        <h2>Personer</h2>
        <p>Namnen används för att känna igen talare i mötena.</p>
        <ul>
          {people.map((person) => (
            <li key={person.id}>
              <form action={renamePersonAction} style={{ display: "inline" }}>
                <input type="hidden" name="orgId" value={org.id} />
                <input type="hidden" name="personId" value={person.id} />
                <input name="name" defaultValue={person.name} required maxLength={100} aria-label="Namn" />{" "}
                <button type="submit">Byt namn</button>
              </form>{" "}
              <form action={deletePersonAction} style={{ display: "inline" }}>
                <input type="hidden" name="orgId" value={org.id} />
                <input type="hidden" name="personId" value={person.id} />
                <button type="submit">Ta bort</button>
              </form>
            </li>
          ))}
        </ul>
        <form action={addPersonAction}>
          <input type="hidden" name="orgId" value={org.id} />
          <label>
            Ny person <input name="name" required maxLength={100} />
          </label>{" "}
          <button type="submit">Lägg till</button>
        </form>
      </section>

      <section>
        <h2>Möten</h2>
        {meetings.length === 0 ? (
          <p>Inga möten än.</p>
        ) : (
          <ul>
            {meetings.map((meeting) => (
              <li key={meeting.id}>
                {time(meeting.started_at)} · {statusText[meeting.status] ?? meeting.status} ·{" "}
                <a href={`https://docs.google.com/document/d/${meeting.doc_id}/edit`}>Dokument</a>{" "}
                <form action={deleteMeetingAction} style={{ display: "inline" }}>
                  <input type="hidden" name="orgId" value={org.id} />
                  <input type="hidden" name="meetingId" value={meeting.id} />
                  <button type="submit">Radera</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <p>
          Radera ett möte tar bort transkription, anteckningar och logg här. Google-dokumentet ligger kvar i
          Drive.
        </p>
      </section>

      {isAdmin && (
        <>
          <section>
            <h2>Inställningar</h2>
            <form action={updateOrgAction}>
              <input type="hidden" name="orgId" value={org.id} />
              <p>
                <label>
                  Namn <input name="name" defaultValue={org.name} required maxLength={100} />
                </label>
              </p>
              <p>
                <label>
                  <input type="checkbox" name="share_transcript" defaultChecked={org.share_transcript} /> Dela
                  transkriptionen i dokumentet
                </label>
              </p>
              <p>
                <label>
                  <input type="checkbox" name="show_on_status" defaultChecked={org.show_on_status} /> Visa
                  organisationen på statussidan
                </label>
              </p>
              <button type="submit">Spara</button>
            </form>
          </section>

          <section>
            <h2>Radera organisationen</h2>
            <p>
              Tar bort organisationen med alla möten, transkriptioner, anteckningar och personer. Det går inte att
              ångra. Google-dokumenten ligger kvar i Drive.
            </p>
            <form action={deleteOrgAction}>
              <input type="hidden" name="orgId" value={org.id} />
              <label>
                Skriv <strong>{org.name}</strong> för att bekräfta{" "}
                <input name="confirmName" required autoComplete="off" />
              </label>{" "}
              <button type="submit">Radera organisationen</button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
