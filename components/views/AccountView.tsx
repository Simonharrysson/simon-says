import { ButtonLink } from "@/components/ui/Button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";

export function AccountView({ email, userId, signOut }: { email: string; userId: string; signOut: FormAction }) {
  return (
    <div className="page page--narrow stack" style={{ ["--stack-gap" as string]: "1.5rem" }}>
      <PageHeader title="Ditt konto" />
      <Panel title="Inloggad som" titleId="account-title">
        <dl className="facts">
          <div>
            <dt>Google-konto</dt>
            <dd>{email}</dd>
          </div>
          <div>
            <dt>Användar-id</dt>
            <dd>
              <code className="user-id">{userId}</code>
              <span className="hint">Bra att ha om du behöver hjälp med något.</span>
            </dd>
          </div>
        </dl>
      </Panel>
      <Panel title="Organisationer och möten" titleId="orgs-link-title">
        <div className="stack" style={{ ["--stack-gap" as string]: "1rem" }}>
          <p className="muted">
            Personlistor, inbjudningslänkar och inställningar för transkriptionen finns under varje organisation.
          </p>
          <div>
            <ButtonLink href="/orgs" icon={<IconArrowRight />}>
              Dina organisationer
            </ButtonLink>
          </div>
        </div>
      </Panel>
      <Panel title="Integritet" titleId="privacy-title">
        <p className="muted measure">
          Mötesdokumenten ligger i din egen Google Drive och raderas aldrig av oss. Transkriptioner och anteckningar hos
          oss raderas när du raderar mötet eller organisationen. Läs mer i{" "}
          <a href="/integritet">integritetsinformationen</a>.
        </p>
      </Panel>
      <form action={signOut}>
        <SubmitButton pendingLabel="Loggar ut…">Logga ut</SubmitButton>
      </form>
    </div>
  );
}
