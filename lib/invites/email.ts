// The invite e-mail, design A "Calm Geist" (emails/invite/a.html is the reference rendering;
// variants B and C were considered, see docs/ui.md). Pure, no `server-only`: the route sends it,
// the invite form previews it and the tests render it.
//
// Every value is user-supplied (names typed by admins): HTML-escaped in the HTML part; in the
// subject, preheader and text part newlines and control characters are collapsed instead.

export interface InviteEmailInput {
  /** Who invites: their name in the förening's list, or their Google name. Never an e-mail address. */
  inviterName: string;
  orgName: string;
  /** The förening's existing join link (`/join/<code>`), read at send time. */
  inviteUrl: string;
  /** The recipient's signed mail-settings link (`emailPrefsUrl(email, "invite")`, 0039), per address. */
  prefsUrl?: string;
}

export interface InviteEmail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

/** One line of plain text: control characters and runs of whitespace become one space. */
export function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Does a name look like a link or an address (`bank-login.se`, `www.…`, `https://…`, `a@b`)?
 * Mail clients turn those into links, and a mail from our domain must not carry someone else's
 * link: invites are refused until the förening (or the admin) is renamed.
 */
export function looksLikeLink(s: string): boolean {
  const t = oneLine(s);
  return /:\/\/|www\.|@/i.test(t) || /[\p{L}\p{N}_-]\.[a-z]{2,}/iu.test(t);
}

/** Which name stops the invite, if any. */
export function linkLikeName(inviterName: string, orgName: string): "org" | "inviter" | null {
  if (looksLikeLink(orgName)) return "org";
  if (looksLikeLink(inviterName)) return "inviter";
  return null;
}

/** Defence in depth: a zero-width non-joiner after every dot, so no name can auto-link. */
export function defang(s: string): string {
  return s.replace(/\.(?!\u200c)/g, ".\u200c");
}

/** Subjects are cut at this many characters (with "…"). */
export const SUBJECT_MAX = 80;

export const INVITE_PREHEADER = "Gå med så kan du starta möten och läsa föreningens mötesanteckningar.";

export function inviteSubject(inviterName: string, orgName: string): string {
  const subject = `${defang(oneLine(inviterName))} bjuder in dig till ${defang(oneLine(orgName))} på Simon Says`;
  return subject.length > SUBJECT_MAX ? `${subject.slice(0, SUBJECT_MAX - 1).trimEnd()}…` : subject;
}

/** The link as shown under the button: without the scheme. */
const displayUrl = (url: string) => url.replace(/^https?:\/\//, "");

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SPACER = "&#847;&zwnj;&nbsp;".repeat(24);

export function inviteEmail(input: InviteEmailInput): InviteEmail {
  const inviter = defang(oneLine(input.inviterName));
  const org = defang(oneLine(input.orgName));
  const url = oneLine(input.inviteUrl);
  if (!/^https?:\/\//.test(url)) throw new Error("inviteEmail: the invite URL must be http(s)");
  const subject = inviteSubject(inviter, org);
  const prefsUrl = input.prefsUrl ? oneLine(input.prefsUrl) : null;
  if (prefsUrl && !/^https?:\/\//.test(prefsUrl)) throw new Error("inviteEmail: the settings URL must be http(s)");
  const h = { inviter: escapeHtml(inviter), org: escapeHtml(org), url: escapeHtml(url), shown: escapeHtml(displayUrl(url)), subject: escapeHtml(subject) };

  const html = `<!doctype html>
<html lang="sv" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${h.subject}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>table,td,p,a,h1,span{font-family:Arial,Helvetica,sans-serif !important;}.wm{font-family:Georgia,'Times New Roman',serif !important;}</style>
<![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
  a { text-decoration: none; }
  @media (max-width: 599px) {
    .card-pad { padding: 32px 24px !important; }
    .outer-pad { padding: 16px 12px !important; }
    .h1 { font-size: 26px !important; line-height: 32px !important; }
    .btn-full { width: 100% !important; }
    .btn-full a { display: block !important; text-align: center !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bg-board { background-color: #000000 !important; }
    .bg-card { background-color: #0a0a0a !important; border-color: #2e2e2e !important; }
    .ink { color: #ededed !important; }
    .ink-2 { color: #bdbdbd !important; }
    .ink-3 { color: #a1a1a1 !important; }
    .rule { border-color: #2e2e2e !important; }
    .btn-td { background-color: #ededed !important; }
    .btn-a { color: #0a0a0a !important; }
    .link { color: #52a8ff !important; }
  }
  [data-ogsc] .ink { color: #ededed !important; }
  [data-ogsc] .ink-2 { color: #bdbdbd !important; }
  [data-ogsc] .ink-3 { color: #a1a1a1 !important; }
  [data-ogsc] .link { color: #52a8ff !important; }
  [data-ogsb] .bg-board { background-color: #000000 !important; }
  [data-ogsb] .bg-card { background-color: #0a0a0a !important; }
</style>
</head>
<body class="bg-board" style="margin:0; padding:0; background-color:#fafafa;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#fafafa; opacity:0;">
    ${escapeHtml(INVITE_PREHEADER)}
    ${SPACER}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-board" style="background-color:#fafafa;">
    <tr>
      <td align="center" class="outer-pad" style="padding:48px 16px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; margin:0 auto;">
          <tr>
            <td style="padding:0 4px 20px 4px;">
              <span class="wm ink" style="font-family:'Instrument Serif',Georgia,'Times New Roman',serif; font-size:26px; line-height:30px; font-weight:400; color:#171717; letter-spacing:-0.01em;">Simon Says</span>
            </td>
          </tr>
          <tr>
            <td class="bg-card card-pad" style="background-color:#ffffff; border:1px solid #ebebeb; border-radius:8px; padding:48px 48px 40px 48px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <h1 class="ink h1" style="margin:0 0 16px 0; font-family:${FONT}; font-size:32px; line-height:38px; font-weight:600; letter-spacing:-0.8px; color:#171717;">Gå med i ${h.org}</h1>
                    <p class="ink-2" style="margin:0 0 32px 0; font-family:${FONT}; font-size:16px; line-height:26px; color:#4d4d4d;">${h.inviter} har bjudit in dig till föreningen på Simon Says. Där skrivs mötesanteckningarna medan ni pratar, direkt i ett Google Doc. Som medlem kan du starta möten och läsa alla tidigare mötesdokument.</p>
                  </td>
                </tr>
                <tr>
                  <td>
                    <table role="presentation" class="btn-full" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="btn-td" bgcolor="#171717" style="background-color:#171717; border-radius:6px;">
                          <a class="btn-a" href="${h.url}" target="_blank" style="display:inline-block; padding:14px 24px; font-family:${FONT}; font-size:16px; line-height:20px; font-weight:500; color:#ffffff; text-decoration:none; border-radius:6px;">Gå med i ${h.org}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding-top:24px;">
                    <p class="ink-3" style="margin:0; font-family:${FONT}; font-size:13px; line-height:20px; color:#666666;">Fungerar inte knappen? Öppna länken:<br>
                      <a class="link" href="${h.url}" target="_blank" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; color:#0068d6; text-decoration:none; word-break:break-all;">${h.shown}</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 4px 0 4px;">
              <p class="ink-3" style="margin:0; font-family:${FONT}; font-size:13px; line-height:20px; color:#666666;">${inviteFooter(h.inviter, h.org)}${prefsUrl ? ` <a class="link" href="${escapeHtml(prefsUrl)}" target="_blank" style="color:#0068d6; text-decoration:none;">Vill du inte få inbjudningar? Ändra dina mejlval.</a>` : ""}</p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>
`;

  const text = [
    `Gå med i ${org}`,
    "",
    inviteBody(inviter),
    "",
    "Gå med här (du loggar in med Google och går med med en knapp):",
    url,
    "",
    "--",
    "Simon Says",
    `Du får det här mejlet för att ${inviter} lade till din adress i ${org}. Väntade du dig inte mejlet kan du strunta i det, inget händer förrän du går med.`,
    ...(prefsUrl ? [`Vill du inte få inbjudningar? Ändra dina mejlval: ${prefsUrl}`] : []),
    "",
  ].join("\n");

  return { subject, preheader: INVITE_PREHEADER, html, text };
}

/** The paragraph under the heading (plain text; the form's preview shows the same words). */
export function inviteBody(inviterName: string): string {
  return `${oneLine(inviterName)} har bjudit in dig till föreningen på Simon Says. Där skrivs mötesanteckningarna medan ni pratar, direkt i ett Google Doc. Som medlem kan du starta möten och läsa alla tidigare mötesdokument.`;
}

/** The footer line; arguments are already safe for the output (escaped for HTML, or plain). */
export function inviteFooter(inviter: string, org: string): string {
  return `Du får det här mejlet för att ${inviter} lade till din adress i ${org}. Du loggar in med Google och går med med en knapp. Väntade du dig inte mejlet kan du strunta i det, inget händer förrän du går med.`;
}
