import { useTranslations } from "next-intl";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { Wordmark } from "@/components/ui/Wordmark";
import { HeaderFrame } from "./HeaderFrame";
import { MobileMenu } from "./MobileMenu";
import { StartAction } from "./StartAction";

/** The landing's sections, in page order: the header links and the sheet menu use the same list. */
export const LANDING_NAV = [
  { href: "#funktioner", key: "features" },
  { href: "#foretag", key: "foretag" },
  { href: "#foreningar", key: "foreningar" },
  { href: "#pris", key: "pricing" },
  { href: "#faq", key: "faq" },
] as const;

const linkClass =
  "inline-flex min-h-10 items-center rounded-md px-3 text-sm font-medium text-ink-2 no-underline press hover:bg-sunk hover:text-ink hover:no-underline";

/**
 * The landing's own top rail (the other public pages keep SiteHeader): section links, Logga in
 * and the primary "Kom igång gratis"; a sheet menu on narrow screens. It blurs what scrolls under
 * it once the page has moved (HeaderFrame).
 */
export function LandingHeader({ signedIn, signIn }: { signedIn: boolean; signIn: FormAction }) {
  const t = useTranslations("landing.nav");
  const links = LANDING_NAV.map((l) => ({ href: l.href, label: t(l.key) }));
  return (
    <HeaderFrame>
      <div className="mx-auto flex min-h-16 w-full max-w-page items-center gap-2 px-gutter">
        <Wordmark />
        <nav aria-label={t("label")} className="ml-6 hidden items-center gap-0.5 min-[64rem]:flex">
          {links.map((l) => (
            <a key={l.href} className={linkClass} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {!signedIn && (
            <a className={`${linkClass} hidden min-[64rem]:inline-flex`} href="/login">
              {t("signIn")}
            </a>
          )}
          <div className="max-[22rem]:hidden">
            <StartAction signedIn={signedIn} signIn={signIn} size="md" />
          </div>
          <MobileMenu links={links} signedIn={signedIn} signIn={signIn} />
        </div>
      </div>
    </HeaderFrame>
  );
}
