import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { ConfirmAction, type FormAction } from "@/components/ui/ConfirmAction";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconExternal, IconMic, IconPlus, IconRefresh, IconTrash } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { MeetingStatus } from "@/lib/db/types";
import { formatDateTime, formatDuration, plural } from "@/lib/format";
import { docUrl, meetingDeleteState, meetingStatusLabel } from "@/lib/ui/meetings";
import type { Notice } from "@/lib/ui/messages";
import { NoticeBanner } from "./NoticeBanner";
import { OrgSettingsForm } from "./OrgSettingsForm";
import { PersonRow } from "./PersonRow";

export interface OrgDetailMeeting {
  id: string;
  status: MeetingStatus;
  started_at: string;
  ended_at: string | null;
  doc_id: string;
  started_by: string | null;
}

export interface OrgDetailViewProps {
  org: { id: string; name: string; share_transcript: boolean; show_on_status: boolean };
  isAdmin: boolean;
  userId: string | null;
  inviteUrl: string;
  /** Member emails, oldest first. Omitted when unavailable. */
  members?: string[];
  people: { id: string; name: string }[];
  meetings: OrgDetailMeeting[];
  notice: Notice | null;
  /** Link to start a meeting (Task 7). Hidden until the live page exists. */
  startMeetingHref?: string;
  actions: {
    rotateInvite: FormAction;
    addPerson: FormAction;
    renamePerson: FormAction;
    deletePerson: FormAction;
    deleteMeeting: FormAction;
    updateOrg: FormAction;
    deleteOrg: FormAction;
  };
}

const statusTone: Record<MeetingStatus, BadgeTone> = {
  live: "live",
  ending: "neutral",
  done: "success",
  abandoned: "neutral",
};

export function OrgDetailView(props: OrgDetailViewProps) {
  const { org, isAdmin, userId, inviteUrl, members, people, meetings, notice, startMeetingHref, actions } = props;
  const nameError = notice?.text.startsWith("Ange ett namn") ? notice.text : undefined;

  return (
    <div className="page stack" style={{ ["--stack-gap" as string]: "1.5rem" }}>
      <PageHeader
        back={{ href: "/orgs", label: "Organisationer" }}
        title={org.name}
        meta={
          <div className="cluster" style={{ ["--cluster-gap" as string]: "0.75rem" }}>
            <Badge tone={isAdmin ? "info" : "neutral"}>{isAdmin ? "Du är admin" : "Du är medlem"}</Badge>
            <span className="subtle">
              {plural(people.length, "person", "personer")} · {plural(meetings.length, "möte", "möten")}
            </span>
          </div>
        }
        actions={
          startMeetingHref && (
            <ButtonLink href={startMeetingHref} variant="primary" size="lg" icon={<IconMic />}>
              Starta ett möte
            </ButtonLink>
          )
        }
      />
      <NoticeBanner notice={notice} />

      <div className="org-grid">
        <div className="stack" style={{ ["--stack-gap" as string]: "1.5rem" }}>
          <MeetingsPanel meetings={meetings} orgId={org.id} isAdmin={isAdmin} userId={userId} deleteMeeting={actions.deleteMeeting} />
          <PeoplePanel orgId={org.id} people={people} actions={actions} />
        </div>

        <div className="stack" style={{ ["--stack-gap" as string]: "1.5rem" }}>
          <Panel title="Bjud in" titleId="invite-title">
            <div className="stack" style={{ ["--stack-gap" as string]: "0.75rem" }}>
              <p className="subtle">
                Den som öppnar länken och loggar in med Google blir medlem och kan starta möten.
              </p>
              <CopyField id="invite-url" value={inviteUrl} label="Inbjudningslänk" />
              {isAdmin && (
                <div>
                  <ConfirmAction
                    action={actions.rotateInvite}
                    hidden={{ orgId: org.id }}
                    trigger="Skapa ny länk"
                    triggerVariant="ghost"
                    triggerIcon={<IconRefresh size={18} />}
                    title="Skapa en ny inbjudningslänk?"
                    description="Den gamla länken slutar fungera direkt. Den som redan är medlem påverkas inte."
                    confirmLabel="Skapa ny länk"
                    confirmVariant="primary"
                    pendingLabel="Skapar…"
                  />
                </div>
              )}
            </div>
          </Panel>

          {members && (
            <Panel flush title="Medlemmar" titleId="members-title" actions={<span className="subtle">{members.length}</span>}>
              <p className="subtle panel-intro">Kan logga in, starta möten och får tillgång till nya mötesdokument.</p>
              <ul className="list" aria-labelledby="members-title">
                {members.map((email) => (
                  <li key={email}>
                    <div className="row row--compact">
                      <span className="row__main">
                        <span className="row__title member-email">{email}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>

      {isAdmin && (
        <>
          <Panel title="Inställningar" titleId="settings-title" id="installningar">
            <OrgSettingsForm org={org} updateOrg={actions.updateOrg} nameError={nameError} />
          </Panel>

          <Panel title="Radera organisationen" titleId="danger-title" className="panel--danger">
            <div className="danger-zone">
              <p className="muted measure">
                Tar bort organisationen med alla möten, transkriptioner, anteckningar och personer här. Det går
                inte att ångra. Google-dokumenten ligger kvar i Drive.
              </p>
              <ConfirmAction
                action={actions.deleteOrg}
                hidden={{ orgId: org.id }}
                trigger="Radera organisationen"
                triggerVariant="danger"
                triggerSize="md"
                triggerIcon={<IconTrash size={18} />}
                title={`Radera ${org.name}?`}
                description="Alla möten, transkriptioner, anteckningar och personer försvinner. Google-dokumenten ligger kvar i Drive."
                requireText={{
                  name: "confirmName",
                  value: org.name,
                  label: (
                    <>
                      Skriv <strong>{org.name}</strong> för att bekräfta
                    </>
                  ),
                }}
                confirmLabel="Radera för alltid"
                pendingLabel="Raderar…"
              />
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function MeetingsPanel({
  meetings,
  orgId,
  isAdmin,
  userId,
  deleteMeeting,
}: {
  meetings: OrgDetailMeeting[];
  orgId: string;
  isAdmin: boolean;
  userId: string | null;
  deleteMeeting: FormAction;
}) {
  return (
    <Panel flush title="Möten" titleId="meetings-title">
      {meetings.length === 0 ? (
        <div className="panel-pad">
          <EmptyState title="Inga möten än">
            <p>
              När någon startar ett möte hamnar det här, med en länk till dokumentet. Anteckningarna skrivs i den
              personens Google Drive och delas med alla medlemmar.
            </p>
          </EmptyState>
        </div>
      ) : (
        <>
          <ul className="list" aria-labelledby="meetings-title">
            {meetings.map((meeting) => {
              const state = meetingDeleteState(meeting, { isAdmin, userId });
              const duration =
                meeting.ended_at &&
                formatDuration((new Date(meeting.ended_at).getTime() - new Date(meeting.started_at).getTime()) / 1000);
              return (
                <li key={meeting.id}>
                  <div className="row meeting-row">
                    <span className="row__main">
                      <span className="row__title">{formatDateTime(meeting.started_at)}</span>
                      <span className="row__meta cluster" style={{ ["--cluster-gap" as string]: "0.5rem" }}>
                        <Badge tone={statusTone[meeting.status]}>{meetingStatusLabel[meeting.status]}</Badge>
                        {duration && <span>{duration}</span>}
                        {state === "active" && <span>Avsluta mötet innan du raderar det.</span>}
                      </span>
                    </span>
                    <span className="row__actions">
                      <a
                        className="btn btn--sm"
                        href={docUrl(meeting.doc_id)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Dokument
                        <IconExternal size={16} />
                        <span className="visually-hidden">(öppnas i ny flik)</span>
                      </a>
                      {state === "allowed" && (
                        <ConfirmAction
                          action={deleteMeeting}
                          hidden={{ orgId, meetingId: meeting.id }}
                          trigger={`Radera mötet ${formatDateTime(meeting.started_at)}`}
                          triggerIcon={<IconTrash size={18} />}
                          triggerIconOnly
                          title="Radera mötet?"
                          description="Transkriptionen, anteckningarna och loggen här tas bort. Google-dokumentet ligger kvar i Drive."
                          confirmLabel="Radera mötet"
                          pendingLabel="Raderar…"
                        />
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="subtle panel-foot">
            Att radera ett möte tar bort transkription, anteckningar och logg här. Google-dokumentet ligger kvar.
          </p>
        </>
      )}
    </Panel>
  );
}

function PeoplePanel({
  orgId,
  people,
  actions,
}: {
  orgId: string;
  people: { id: string; name: string }[];
  actions: OrgDetailViewProps["actions"];
}) {
  return (
    <Panel flush title="Personer" titleId="people-title" actions={<span className="subtle">{people.length}</span>}>
      <p className="subtle panel-intro">
        Alla som brukar vara med på mötena. Namnen används för att känna igen vem som talar. De behöver inget konto.
      </p>
      <form action={actions.addPerson} className="inline-form panel-pad add-person">
        <input type="hidden" name="orgId" value={orgId} />
        <div className="field">
          <label className="visually-hidden" htmlFor="new-person">
            Namn på ny person
          </label>
          <input id="new-person" className="input" name="name" placeholder="Namn, t.ex. Anna Berg" required maxLength={100} autoComplete="off" />
        </div>
        <SubmitButton icon={<IconPlus />} pendingLabel="Lägger till…">
          Lägg till
        </SubmitButton>
      </form>
      {people.length === 0 ? (
        <div className="panel-pad">
          <EmptyState title="Inga personer än">
            <p>Lägg till de som brukar vara med. Det går också bra att låta namnrundan i första mötet fylla på listan.</p>
          </EmptyState>
        </div>
      ) : (
        <ul className="list people-list" aria-labelledby="people-title">
          {people.map((person) => (
            <PersonRow
              key={person.id}
              orgId={orgId}
              person={person}
              renamePerson={actions.renamePerson}
              deletePerson={actions.deletePerson}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}
