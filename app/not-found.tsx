import { ButtonLink } from "@/components/ui/button";
import { IconArrowLeft } from "@/components/ui/icons";
import { PublicShell } from "@/components/views/PublicShell";

export default function NotFound() {
  return (
    <PublicShell signedIn={false}>
      <div className="page page--narrow oops">
        <p className="oops__code">404</p>
        <h1 className="oops__title">Här finns ingenting</h1>
        <p className="muted">
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
