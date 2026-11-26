import { ButtonLink } from "@/components/ui/button";
import { IconArrowLeft } from "@/components/ui/icons";

// A notFound() inside the signed-in area renders inside app/(app)/layout.tsx, which already has
// the header, <main> and footer: only the message here (the root not-found's PublicShell would
// add a second header with "Logga in" and a nested <main>).
export default function SignedInNotFound() {
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] flex flex-col items-start gap-4 py-[clamp(2rem,8vh,6rem)]">
      <p className="font-mono text-sm text-ink-3">404</p>
      <h1 className="text-2xl">Här finns ingenting</h1>
      <p className="text-ink-2">
        Sidan har flyttats, raderats eller så har du inte tillgång till den. Är det en förening kan en admin bjuda in dig.
      </p>
      <ButtonLink href="/orgs" icon={<IconArrowLeft />}>
        Till dina föreningar
      </ButtonLink>
    </div>
  );
}
