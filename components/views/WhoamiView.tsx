import Link from "next/link";
import { useTranslations } from "next-intl";
import { Banner } from "@/components/ui/Banner";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { Field } from "@/components/ui/Field";
import { IconPlus } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { WhoamiError } from "@/lib/people/whoami";
import { WhoamiPick } from "./WhoamiPick";

export interface WhoamiViewProps {
  orgId: string;
  orgName: string;
  /** Unlinked people the member can pick (claimable()), sorted. */
  people: { id: string; name: string; role: string | null }[];
  /** "Jag finns inte med" is open (`?ny=1`, or nobody left to pick). */
  adding: boolean;
  error: WhoamiError | null;
  /** First guess for the name field (the Google account's name). */
  suggestedName: string;
  claim: FormAction;
  addSelf: FormAction;
}

/**
 * "Vem av dessa är du?" (UX walkthrough 2026-11-27, 3): right after "Gå med" the member taps their
 * name, or adds themselves. Plain forms and links (no client state): works before hydration.
 */
export function WhoamiView({ orgId, orgName, people, adding, error, suggestedName, claim, addSelf }: WhoamiViewProps) {
  const t = useTranslations("join.whoami");
  const showForm = adding || people.length === 0;
  const fieldError = error === "namn" || error === "roll" ? error : null;
  const pageError = error && !fieldError ? t(`error.${error}`) : null;
  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-8 px-gutter pt-[clamp(1rem,6vh,4rem)] pb-16">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-ink-2 wrap-anywhere">{t("eyebrow", { org: orgName })}</p>
        <h1 className="text-[clamp(1.75rem,1.4rem+1.6vw,2.4rem)]">{t("title")}</h1>
        {people.length > 0 && <p className="max-w-[55ch] text-ink-2">{t("text")}</p>}
      </div>

      {pageError && <Banner tone="danger">{pageError}</Banner>}

      {people.length > 0 && (
        <ul aria-label={t("listLabel", { org: orgName })} className="flex flex-col gap-2">
          {people.map((p) => (
            <li key={p.id}>
              <form action={claim}>
                <input type="hidden" name="orgId" value={orgId} />
                <input type="hidden" name="personId" value={p.id} />
                <WhoamiPick name={p.name} role={p.role} pendingLabel={t("linking")} />
              </form>
            </li>
          ))}
        </ul>
      )}

      {showForm ? (
        <section data-card aria-labelledby="whoami-add" className="flex flex-col gap-4 rounded-lg bg-surface p-6 shadow-panel">
          <div className="flex flex-col gap-1">
            <h2 id="whoami-add" className="text-lg">
              {people.length === 0 ? t("noneTitle") : t("notListed")}
            </h2>
            <p className="text-sm text-ink-2">{people.length === 0 ? t("noneText") : t("notListedText")}</p>
          </div>
          <form action={addSelf} className="flex flex-col gap-4">
            <input type="hidden" name="orgId" value={orgId} />
            <Field
              id="whoami-name"
              name="name"
              label={t("nameLabel")}
              hint={t("nameHint")}
              error={fieldError === "namn" ? t("error.namn") : undefined}
              defaultValue={suggestedName}
              autoComplete="name"
              maxLength={100}
              required
              autoFocus={adding}
            />
            <Field
              id="whoami-role"
              name="role"
              label={t("roleLabel")}
              hint={t("roleHint")}
              error={fieldError === "roll" ? t("error.roll") : undefined}
              autoComplete="organization-title"
              maxLength={40}
            />
            <div>
              <SubmitButton variant="primary" pendingLabel={t("adding")}>
                {t("add")}
              </SubmitButton>
            </div>
          </form>
        </section>
      ) : (
        <Link
          href={`/orgs/${orgId}/vem?ny=1`}
          className="flex min-h-14 items-center gap-3 rounded-md border border-dashed border-control px-4 py-3 text-ink-2 transition-colors duration-120 hover:border-ink hover:text-ink"
        >
          <IconPlus size={18} />
          <span className="font-medium">{t("notListed")}</span>
        </Link>
      )}

      <Link href={`/orgs/${orgId}`} className="self-start text-sm text-ink-2 underline underline-offset-4 hover:text-ink">
        {t("later")}
      </Link>
    </div>
  );
}
