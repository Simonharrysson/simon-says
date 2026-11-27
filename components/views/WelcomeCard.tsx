import type { ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { IconX } from "@/components/ui/icons";

/**
 * The förening page's welcome after "Gå med" + "Vem av dessa är du?" (`?valkommen=1`): who they
 * are on the list, the next prepared meeting, where tasks and Docs end up. Closing drops the param.
 */
export function WelcomeCard({ orgId, orgName, name, nextMeeting }: { orgId: string; orgName: string; name: string | null; nextMeeting: string | null }) {
  const t = useTranslations("join.welcome");
  const strong = (chunks: ReactNode) => <strong className="font-medium text-ink wrap-anywhere">{chunks}</strong>;
  return (
    <section data-card aria-labelledby="welcome-title" className="relative flex flex-col gap-3 rounded-lg bg-surface p-6 pr-14 shadow-panel">
      <h2 id="welcome-title" className="text-lg wrap-anywhere">
        {t("title", { org: orgName })}
      </h2>
      <ul className="flex max-w-[60ch] flex-col gap-1.5 text-sm text-ink-2">
        {name && <li>{t.rich("youAre", { name, strong })}</li>}
        {nextMeeting && <li>{t.rich("nextMeeting", { when: nextMeeting, strong })}</li>}
        <li>
          {t.rich("tasks", {
            link: (chunks) => (
              <Link href="/hem" className="text-ink underline underline-offset-4">
                {chunks}
              </Link>
            ),
          })}
        </li>
        <li>{t("docs")}</li>
      </ul>
      <Link
        href={`/orgs/${orgId}`}
        aria-label={t("close")}
        className="absolute top-3 right-3 grid size-11 place-items-center rounded-md text-ink-3 transition-colors duration-120 hover:bg-sunk hover:text-ink"
      >
        <IconX size={18} />
      </Link>
    </section>
  );
}
