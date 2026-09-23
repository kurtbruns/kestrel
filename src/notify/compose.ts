/**
 * The words of each notification to the publisher (SPEC §8): what happened, the numbers
 * or the provider's words that matter, and a link to the send in the admin UI. Plain
 * text first, with a minimal HTML twin, because it is a message about the newsletter to
 * its publisher, not a post: it carries no template, no identity, and no unsubscribe link.
 */

import { refusalAdvice } from "../../shared/sends";
import type { DueNotification } from "../db/notifications";
import type { Config } from "../env";
import { escapeHtml, escapeHtmlAttr } from "../lib/html";
import { STUCK_THRESHOLD_MS } from "../lib/time";
import type { RenderedEmail } from "../render/render";

/** A moment as the publisher reads it in a notification: UTC, to the minute. */
function when(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/** The send's page in the admin UI: the record once sent, the live watch before. */
export function sendLink(config: Config, sendId: string): string {
  return `${config.appOrigin}/dashboard/#/sent/${encodeURIComponent(sendId)}`;
}

/** Paragraphs and a closing link, as both a text and an HTML body. */
function message(subject: string, paragraphs: string[], link: string): RenderedEmail {
  const text = `${paragraphs.join("\n\n")}\n\n${link}\n`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#18181b;">
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")}
<p><a href="${escapeHtmlAttr(link)}">${escapeHtml(link)}</a></p>
</body></html>`;
  return { subject, html, text };
}

/** Write the notification for one event, from the send as it stands now. */
export function composeNotification(n: DueNotification, config: Config): RenderedEmail {
  const link = sendLink(config, n.send_id);
  const title = `"${n.subject}"`;
  switch (n.kind) {
    case "finished": {
      const accepted = n.c_accepted + n.c_delivered + n.c_bounced + n.c_complained;
      const audience = accepted + n.c_unsent + n.c_skipped + n.c_pending + n.c_in_flight;
      return message(
        `Sent: ${n.subject}`,
        [
          `${title} finished sending${n.completed_at ? ` at ${when(n.completed_at)}` : ""}.`,
          `Accepted by the provider: ${accepted} of ${audience}. Unsent: ${n.c_unsent}. Skipped (unsubscribed or suppressed since it was scheduled): ${n.c_skipped}.`,
          "Delivery receipts, bounces, and complaints keep arriving after this; the record shows them as they land.",
        ],
        link,
      );
    }
    case "refused":
      return message(
        `Needs you: the provider is refusing to send ${title}`,
        [
          `The email provider is refusing this account, so ${title} is paused where it is. The provider said: ${n.halt_error || "no detail given"}`,
          refusalAdvice(n.halt_cause),
          "No one has been marked unsent. The send tries again every minute and resumes on its own once the account is fixed, mailing no one twice.",
        ],
        link,
      );
    case "stuck":
      return message(
        `Needs you: ${title} has been sending for over ${minutes(STUCK_THRESHOLD_MS)} minutes`,
        [
          `${title} started sending${n.started_at ? ` at ${when(n.started_at)}` : ""} and is still going: ${n.c_pending + n.c_in_flight} recipients have not been handed to the provider yet.`,
          "It keeps retrying on its own. If it stays like this, check the provider's status and the send's page.",
        ],
        link,
      );
    case "wedged":
      return message(
        `Needs you: ${title} is waiting for you to resolve it`,
        [
          `${title} has handed off everyone it can, but the provider never answered for ${n.c_in_flight} recipients, so whether they were mailed is unknown. Sending them again could mail them twice, so the send waits for you.`,
          "Open the send and choose Resolve: assume they were not sent, or that they were, once you have checked the provider's console.",
        ],
        link,
      );
    case "missed": {
      const late =
        n.send_status === "scheduled"
          ? `${title} was due at ${when(n.fire_at)} and has not gone out.`
          : `${title} was due at ${when(n.fire_at)} and went out ${minutes((n.started_at ?? n.fire_at) - n.fire_at)} minutes late.`;
      return message(
        `Late: ${title} missed its fire time`,
        [
          late,
          "A send only goes out late when the minute-by-minute sweep that fires it was not running or failed on it, so check the Worker's cron trigger and logs.",
        ],
        link,
      );
    }
  }
}

/** A sample, for the settings surface's test, so the channel can be proved before a send needs it. */
export function sampleNotification(config: Config): RenderedEmail {
  return message(
    "Test: notifications from Kestrel",
    [
      "This is a test of the notifications that tell you when a send finishes or needs you.",
      "If it arrived, the channel works; nothing else was sent.",
    ],
    `${config.appOrigin}/dashboard/#/settings`,
  );
}
