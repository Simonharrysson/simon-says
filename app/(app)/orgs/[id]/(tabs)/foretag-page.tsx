import { getLocale, getTranslations } from "next-intl/server";
import { ForetagView, type ForetagTab } from "@/components/foretag/ForetagView";
import type { OrgRow } from "@/lib/db/types";
import { CompanyDetailsForm } from "@/components/settings/OrgDetails";
import { loadForetagPage } from "@/lib/foretag/page";
import { logoUrl } from "@/lib/orgs/logo";
import { appOrigin } from "@/lib/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { orgNotice } from "@/lib/ui/messages";
import { addTreePersonAction, renameForetagAction, setManagerAction } from "../../foretag-actions";
import { deleteOrgAction, leaveOrgAction, rotateInviteAction, setMemberRoleAction } from "../../actions";

const TABS: ForetagTab[] = ["moten", "kunder", "personer", "installningar"];
/** Codes of the Personer & grupper forms open that tab; the name form's opens Inställningar. */
const PEOPLE_CODES = ["grupp", "grupp-arkiv", "placering"];

export function foretagTab(flik: string | undefined, isAdmin: boolean, code: string | null | undefined): ForetagTab {
  if (flik && (TABS as string[]).includes(flik)) return flik === "installningar" && !isAdmin ? "moten" : (flik as ForetagTab);
  if (code && PEOPLE_CODES.includes(code)) return "personer";
  if (code === "namn" && isAdmin) return "installningar";
  return "moten";
}

const tabHref = (orgId: string) => (tab: ForetagTab) => (tab === "moten" ? `/orgs/${orgId}` : `/orgs/${orgId}?flik=${tab}`);

/** The /orgs/<id> page of a Företag (0050): its own view, nothing of the förening page runs. */
export async function ForetagPage({ org, role, userId, flik, fel, klart }: { org: OrgRow; role: "admin" | "member"; userId: string; flik?: string; fel?: string; klart?: string }) {
  const db = await createSupabaseServerClient();
  const locale = await getLocale();
  const t = await getTranslations("org");
  const notice = orgNotice(fel, klart, locale);
  const isAdmin = role === "admin";
  const data = await loadForetagPage(db, org.id, userId, t("titleAnd"));
  return (
    <ForetagView
      org={{ id: org.id, name: org.name, logoUrl: logoUrl(org.id, org.logo_updated_at), website_url: org.website_url ?? null }}
      isAdmin={isAdmin}
      userId={userId}
      tab={foretagTab(flik, isAdmin, notice?.code)}
      tabHref={tabHref(org.id)}
      inviteUrl={`${appOrigin()}/join/${org.invite_code}`}
      notice={notice}
      data={data}
      detailsSettings={
        isAdmin ? (
          <CompanyDetailsForm
            org={{ id: org.id, name: org.name, logoUpdatedAt: org.logo_updated_at ?? null, profile: { about: org.about ?? null, website_url: org.website_url ?? null, facebook_url: org.facebook_url ?? null, instagram_url: org.instagram_url ?? null } }}
          />
        ) : undefined
      }
      actions={{
        setManager: setManagerAction,
        addPerson: addTreePersonAction,
        rename: renameForetagAction,
        rotateInvite: rotateInviteAction,
        setMemberRole: setMemberRoleAction,
        deleteOrg: deleteOrgAction,
        leaveOrg: leaveOrgAction,
      }}
    />
  );
}
