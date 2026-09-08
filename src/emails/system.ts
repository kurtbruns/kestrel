/** Transactional (system) emails — confirmation, etc. Sent through the same
 *  provider seam as newsletter sends, so dev uses the fake transport. */
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

export function confirmationEmail(confirmUrl: string): RenderedEmail {
  const subject = "Confirm your subscription";
  const html = systemEmailLayout(
    subject,
    `<p>Thanks for subscribing. Please confirm your email address to start receiving the newsletter.</p>
<p><a href="${escapeHtmlAttr(
      confirmUrl,
    )}" style="display:inline-block;padding:12px 20px;background:#18181b;color:#ffffff;border-radius:6px;text-decoration:none;">Confirm subscription</a></p>
<p style="color:#71717a;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>`,
  );
  const text = `Confirm your subscription\n\nThanks for subscribing. Confirm your email address to start receiving the newsletter:\n${confirmUrl}\n\nIf you didn't request this, you can ignore this email.\n`;
  return { subject, html, text };
}
