import { ButtonLink } from "@/components/ui/button";
import { IconFacebook, IconGlobe, IconInstagram } from "@/components/ui/icons";
import { hasProfile, websiteLabel, type OrgProfile } from "@/lib/orgs/profile";

/**
 * "Om oss" (todo #13) in the förening page's header: the short text and small icon links to the
 * website, Facebook and Instagram (new tab). Nothing at all when none is set.
 */
export function OrgAbout({ profile }: { profile: Partial<OrgProfile> }) {
  if (!hasProfile(profile)) return null;
  const links = [
    profile.website_url && { href: profile.website_url, label: `Webbplats: ${websiteLabel(profile.website_url)}`, icon: <IconGlobe /> },
    profile.facebook_url && { href: profile.facebook_url, label: "Facebook", icon: <IconFacebook /> },
    profile.instagram_url && { href: profile.instagram_url, label: "Instagram", icon: <IconInstagram /> },
  ].filter((l): l is { href: string; label: string; icon: React.ReactElement } => Boolean(l));

  return (
    <div className="flex max-w-[68ch] flex-col gap-2">
      {profile.about && <p className="whitespace-pre-line text-ink-2 wrap-anywhere">{profile.about}</p>}
      {links.length > 0 && (
        <ul className="-ml-2 flex flex-wrap items-center gap-1" aria-label="Föreningen på nätet">
          {links.map((l) => (
            <li key={l.href}>
              <ButtonLink variant="ghost" iconOnly icon={l.icon} href={l.href} target="_blank" rel="noopener noreferrer" title={l.label} className="text-ink-3">
                {`${l.label} (öppnas i ny flik)`}
              </ButtonLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
