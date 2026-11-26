-- The förening's "Om oss" (todo #13): a short plain-text description and links to its website,
-- Facebook and Instagram, shown to members on the förening page; admins edit them in
-- Inställningar and in Kom igång's first step.
--
-- Strictly additive and backward compatible: four nullable columns (old code never names them),
-- RLS unchanged. The app stores one canonical form (lib/orgs/profile.ts); the checks below accept
-- exactly that form, so a link can never be anything but https (no javascript:, no http:).
-- The förening's own text: shown in the UI, never logged.

alter table public.orgs
  add column about text
    check (about is null or (char_length(about) between 1 and 600 and position(chr(13) in about) = 0)),
  add column website_url text
    check (website_url is null or (char_length(website_url) <= 300 and website_url ~ '^https://[^\s/?#@]+\.[^\s/?#@]+/\S*$')),
  add column facebook_url text
    check (facebook_url is null or (char_length(facebook_url) <= 300 and facebook_url ~ '^https://facebook\.com/[^\s/?#][^\s]*$')),
  add column instagram_url text
    check (instagram_url is null or (char_length(instagram_url) <= 300 and instagram_url ~ '^https://instagram\.com/[A-Za-z0-9._]{1,30}$'));

-- orgs uses column-level update grants (0002, 0023, 0030, 0035); orgs_update lets admins only.
grant update (about, website_url, facebook_url, instagram_url) on table public.orgs to authenticated;
