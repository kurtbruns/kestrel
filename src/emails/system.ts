/** Transactional (system) emails — confirmation, etc. Sent through the same
 *  provider seam as newsletter sends, so dev uses the fake transport. */
import type { ConfirmationEmailCopy } from "../db/settings";
import { escapeHtml, escapeHtmlAttr } from "../lib/html";
import type { RenderedEmail } from "../render/render";

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function systemEmailLayout(subject: string, innerHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    subject,
  )}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;">
<tr><td style="padding:32px;font-family:${FONT};font-size:16px;line-height:1.6;color:#18181b;">
${innerHtml}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/** The publication identity a confirmation email is headed with. Resolved by the
 *  caller (name already falls back to the From display name); an empty logoUrl or name
 *  is fine — the masthead renders only what it has, and nothing when it has neither. */
export interface ConfirmationIdentity {
  name: string;
  tagline: string;
  logoUrl: string;
}

/** The publication masthead: the logo (if any) beside the name + tagline, over a
 *  hairline rule — the identity up top, before the ask. A confirmation email is a
 *  transactional first-touch (not content with a closing sign-off, like an issue), so
 *  it leads with the identity. Same identity typography as the issue sign-off, table-
 *  based + inline styles so it survives mail clients. Returns "" when there is neither
 *  a name nor a logo, so the email degrades to plain. */
function masthead(identity: ConfirmationIdentity): string {
  const hasLogo = Boolean(identity.logoUrl);
  const hasName = Boolean(identity.name);
  if (!hasLogo && !hasName) {
    return "";
  }
  const logoCell = hasLogo
    ? `<td style="padding-right:14px;vertical-align:middle;width:44px;"><img src="${escapeHtmlAttr(
        identity.logoUrl,
      )}" width="44" height="44" alt="${escapeHtmlAttr(
        identity.name,
      )}" style="display:block;border-radius:9px;"></td>`
    : "";
  const name = hasName
    ? `<div style="font:600 17px/1.2 Georgia,'Times New Roman',serif;color:#18181b;">${escapeHtml(
        identity.name,
      )}</div>`
    : "";
  const tagline = identity.tagline
    ? `<div style="font-size:13px;color:#52525b;margin-top:2px;">${escapeHtml(
        identity.tagline,
      )}</div>`
    : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>${logoCell}<td style="vertical-align:middle;">${name}${tagline}</td></tr></table>
<hr style="border:0;border-top:1px solid #e4e4e7;margin:16px 0 22px;">
`;
}

/**
 * Render the double opt-in confirmation email from the operator's copy (SPEC §7).
 * The layout, the confirm link, and the HTML/plain-text parity are Kestrel's; only
 * the words come from `copy` (already resolved, so its required fields are non-blank —
 * see `resolveConfirmationEmail`). The email always leads with the publication masthead
 * (`identity`), which degrades to nothing when no identity is set; the reassurance line
 * drops when blank.
 */
export function confirmationEmail(
  confirmUrl: string,
  copy: ConfirmationEmailCopy,
  identity: ConfirmationIdentity,
): RenderedEmail {
  const subject = copy.subject;
  const reassuranceHtml = copy.reassurance
    ? `\n<p style="color:#71717a;font-size:13px;">${escapeHtml(copy.reassurance)}</p>`
    : "";
  const html = systemEmailLayout(
    subject,
    `${masthead(identity)}<p>${escapeHtml(copy.body)}</p>
<p><a href="${escapeHtmlAttr(
      confirmUrl,
    )}" style="display:inline-block;padding:12px 20px;background:#18181b;color:#ffffff;border-radius:6px;text-decoration:none;">${escapeHtml(
      copy.buttonLabel,
    )}</a></p>${reassuranceHtml}`,
  );
  const reassuranceText = copy.reassurance ? `\n\n${copy.reassurance}` : "";
  const text = `${subject}\n\n${copy.body}\n${confirmUrl}${reassuranceText}\n`;
  return { subject, html, text };
}
