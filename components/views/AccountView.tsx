import { ButtonLink } from "@/components/ui/button";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { IconArrowRight } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";

export function AccountView({ email, userId, signOut }: { email: string; userId: string; signOut: FormAction }) {
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] flex flex-col gap-6">
      <PageHeader title="Ditt konto" />
      <Panel title="Inloggad som" titleId="account-title">
        <dl className="flex flex-col gap-4 [&_dd]:mt-1 [&_dd]:flex [&_dd]:flex-col [&_dd]:gap-1 [&_dd]:wrap-anywhere [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:text-ink-3">
          <div>
            <dt>Google-konto</dt>
            <dd>{email}</dd>
          </div>
          <div>
            <dt>Användar-id</dt>
            <dd>
              <code className="text-sm">{userId}</code>
              <span className="text-xs text-ink-3">Bra att ha om du behöver hjälp med något.</span>
            </dd>
          </div>
        </dl>
      </Panel>
      <Panel title="Föreningar och möten" titleId="orgs-link-title">
        <div className="flex flex-col gap-4">
          <p className="text-ink-2">
            Personlistor, inbjudningslänkar och inställningar för transkriptionen finns under varje förening.
          </p>
          <div>
            <ButtonLink href="/orgs" icon={<IconArrowRight />}>
              Dina föreningar
            </ButtonLink>
          </div>
        </div>
      </Panel>
      <Panel title="Integritet" titleId="privacy-title">
        <p className="text-ink-2 max-w-[68ch]">
          Mötesdokumenten ligger i din egen Google Drive och raderas aldrig av oss. Transkriptioner och anteckningar hos
          oss raderas när du raderar mötet eller föreningen. Läs mer i{" "}
          <a href="/integritet">integritetsinformationen</a>.
        </p>
      </Panel>
      <form action={signOut}>
        <SubmitButton pendingLabel="Loggar ut…">Logga ut</SubmitButton>
      </form>
    </div>
  );
}
