/**
 * The words of each notification to the publisher (SPEC §8). The email says whether anyone has
 * to act, and how; the dashboard holds the details. Every notification is one of two templates,
 * `done` (it finished, nothing to do) or `problem` (something needs someone), which lay named
 * slots out in one order, so a case supplies only its details. Plain text first, with a minimal
 * HTML twin, because it is a message about the newsletter to its publisher, not a post: it
 * carries no template, no identity, and no unsubscribe link.
 */

import { dashboardLink } from "../../shared/dashboard_link";
import { inlineStack, SANS_STACK } from "../../shared/fonts";
import type { SendingRefusal } from "../../shared/provider";
import {
  AWS_STATUS_PAGE,
  isSelfThrottled,
  isSendOwnHalt,
  PASS_THIS_ALONG,
  refusalAdvice,
  SES_RATE_ADVICE,
} from "../../shared/sends";
import { settingsRoute } from "../../shared/settings";
import type { DueNotification } from "../db/notifications";
import type { Config } from "../env";
import { escapeHtml, escapeHtmlAttr } from "../lib/html";
import { scrub } from "../lib/log";
import { MISSED_THRESHOLD_MS, NO_RECEIPTS_NOTICE_AFTER_MS, STUCK_THRESHOLD_MS } from "../lib/time";
import type { RenderedEmail } from "../render/render";

/** The one sentence every held post's email keeps, so the safety facts never vary (I4). */
const NO_ONE_HARMED =
  "No one has been marked unsent because of this, and no one will be mailed twice.";
const WHY_YOU_GOT_THIS =
  "You get these because this address is listed under Settings → Notifications.";
const CRON = "Check the Worker’s Cron Trigger and logs.";

/** A moment as the publisher reads it in a notification: UTC, to the minute. */
function when(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/** A count as the publisher reads it, with the thousands marked. */
function count(n: number): string {
  return n.toLocaleString("en-US");
}

function emails(n: number): string {
  return `${count(n)} ${n === 1 ? "email" : "emails"}`;
}

function recipients(n: number): string {
  return `${count(n)} ${n === 1 ? "recipient" : "recipients"}`;
}

/** A provider's words as an email carries them: a reader's address comes out as its domain,
 *  since an email outlives the login that guards the send's page (SPEC §12). */
function said(error: string | null): string {
  return `SES said: ${scrub(error?.trim() || "no detail given")}`;
}

/** The send's page in the admin UI: the record once sent, the live watch before. Carried
 *  in the query, so it still opens the send after an Access login (`dashboardLink`). */
export function sendLink(config: Config, sendId: string): string {
  return dashboardLink(config.appOrigin, `/sent/${encodeURIComponent(sendId)}`);
}

/** Where an email sends its reader, by what they would go there to do. */
interface Link {
  label: string;
  url: string;
}

/** Paragraphs and a closing link, as both a text and an HTML body. Only the templates call it. */
function message(subject: string, paragraphs: string[], link: Link): RenderedEmail {
  const text = `${paragraphs.join("\n\n")}\n\n${link.label}: ${link.url}\n\n${WHY_YOU_GOT_THIS}\n`;
  const html = `<!doctype html><html><body style="font-family:${inlineStack(SANS_STACK)};font-size:15px;line-height:1.5;color:#18181b;">
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")}
<p><a href="${escapeHtmlAttr(link.url)}">${escapeHtml(link.label)}</a></p>
<p style="font-size:13px;color:#71717a;">${escapeHtml(WHY_YOU_GOT_THIS)}</p>
</body></html>`;
  return { subject, html, text };
}

/** It finished, and no one needs to do anything: what finished and how it went, and anything
 *  worth knowing. */
function done(slots: {
  subject: string;
  happened: string;
  more?: string;
  link: Link;
}): RenderedEmail {
  return message(
    slots.subject,
    slots.more ? [slots.happened, slots.more] : [slots.happened],
    slots.link,
  );
}

/** Something needs someone, in one order every time: what happened and what it affects, the
 *  provider's words, what to do and who does it, and what happens next. */
function problem(slots: {
  subject: string;
  happened: string;
  affected?: string;
  said?: string;
  todo: string;
  next?: string;
  link: Link;
}): RenderedEmail {
  const paragraphs = [
    slots.affected ? `${slots.happened} ${slots.affected}` : slots.happened,
    slots.said,
    slots.todo,
    slots.next,
  ];
  return message(
    slots.subject,
    paragraphs.filter((p): p is string => Boolean(p)),
    slots.link,
  );
}

/** A send that finished: `done`, unless nobody got it for a reason that can be fixed. */
function finished(n: DueNotification, title: string, config: Config): RenderedEmail {
  const report = { label: "See the send report", url: sendLink(config, n.send_id) };
  const at = n.completed_at ? ` at ${when(n.completed_at)}` : "";
  const accepted = n.c_accepted + n.c_delivered + n.c_bounced + n.c_complained;
  const total = accepted + n.c_unsent + n.c_pending + n.c_in_flight;
  if (accepted === 0 && total > 0) {
    return problem({
      subject: `${title} didn’t reach anyone`,
      happened: `${title} finished${at}, but your email provider accepted none of its ${emails(total)}.`,
      affected: "A finished post can’t be sent again.",
      todo: "The send report shows why each one failed. Once that’s sorted out, put the post’s content in a new post to send it.",
      link: report,
    });
  }
  const others = total - accepted;
  const outcome =
    total === 0
      ? "Everyone it was going to had left the list since it was scheduled, so there was no one left to send to."
      : others === 0
        ? `Your email provider accepted ${total === 1 ? "its one email" : `all ${emails(total)}`}.`
        : `Your email provider accepted ${count(accepted)} of ${emails(total)}. The send report shows why ${others === 1 ? "the other one wasn’t" : `the other ${count(others)} weren’t`} sent.`;
  const lateBy = (n.started_at ?? n.fire_at) - n.fire_at;
  return done({
    subject: `Sent: ${n.subject}`,
    happened: `${title} finished sending${at}. ${outcome}`,
    more:
      lateBy > MISSED_THRESHOLD_MS
        ? `It went out ${minutes(lateBy)} minutes late, because Kestrel’s once-a-minute sending job wasn’t running or failed on it. If this keeps happening, check the Worker’s Cron Trigger and logs. ${PASS_THIS_ALONG}`
        : undefined,
    link: report,
  });
}

/** A post held on a refusal that isn't an outage (those are `composeOutageNotification`). */
function refused(n: DueNotification, title: string, config: Config): RenderedEmail {
  const link = { label: "See this send", url: sendLink(config, n.send_id) };
  const at = when(n.halted_at ?? n.episode);
  const waits = "any other post that comes due waits with it";
  if (n.halt_cause === "not_connected") {
    // Held for want of a provider (SPEC §13): no provider is refusing anything, so there are
    // no words to quote.
    return problem({
      subject: `${title} is waiting: no email provider is connected`,
      happened: `${title} came due at ${when(n.fire_at)}, but no email provider is connected to this Kestrel instance, so it hasn’t gone out.`,
      todo: `${refusalAdvice(n.halt_cause)} ${PASS_THIS_ALONG}`,
      next: `It goes out within the hour after that, and ${waits}. ${NO_ONE_HARMED}`,
      link,
    });
  }
  if (n.halt_cause === "invalid_request") {
    return problem({
      subject: `${title} is waiting: Amazon SES refused part of it`,
      happened: `Amazon SES refused part of ${title} as invalid at ${at}.`,
      affected: "Other posts go out as usual.",
      said: said(n.halt_error),
      // Not `refusalAdvice`, which is read where the address shows: here the email hid it.
      todo: "If SES’s words name an address, the send’s page shows it in full. Remove that subscriber, and the send skips them.",
      next: `It carries on at its next try. ${NO_ONE_HARMED}`,
      link,
    });
  }
  if (isSendOwnHalt(n.halt_cause)) {
    // The provider refuses this send's own email, not the account: no other send waits on it
    // (SPEC §12).
    return problem({
      subject: `${title} is waiting: Amazon SES refused it`,
      happened: `Amazon SES started refusing ${title} itself at ${at}.`,
      affected: "Other posts go out as usual.",
      said: said(n.halt_error),
      todo: refusalAdvice(n.halt_cause),
      next: `It keeps trying, at most an hour apart. ${NO_ONE_HARMED}`,
      link,
    });
  }
  const held = n.c_pending + n.c_in_flight;
  const left = `${emails(held)} ${held === 1 ? "is" : "are"} still to go.`;
  if (n.halt_cause === "quota") {
    return problem({
      subject: `${title} is waiting: SES’s daily quota is used up`,
      happened: `${title} stopped at ${at} because SES’s 24-hour quota is used up.`,
      affected: left,
      said: said(n.halt_error),
      todo: refusalAdvice(n.halt_cause),
      next: `It carries on by itself when the quota frees up, trying at most an hour apart, and ${waits}. ${NO_ONE_HARMED}`,
      link,
    });
  }
  if (n.halt_cause === "sandbox") {
    return problem({
      subject: `${title} is waiting: SES is still in the sandbox`,
      happened: `${title} stopped at ${at} because your SES account is still in the sandbox, which mails only addresses verified in SES.`,
      affected: left,
      said: said(n.halt_error),
      todo: refusalAdvice(n.halt_cause),
      next: `It carries on by itself once AWS grants production access, trying at most an hour apart, and ${waits}. ${NO_ONE_HARMED}`,
      link,
    });
  }
  return problem({
    subject: `${title} is waiting: Amazon SES is refusing your account`,
    happened: `Amazon SES started refusing your account at ${at}, so ${title} is waiting.`,
    affected: left,
    said: said(n.halt_error),
    todo: refusalAdvice(n.halt_cause),
    next: `It carries on by itself within the hour once that’s fixed, and ${waits}. ${NO_ONE_HARMED}`,
    link,
  });
}

/**
 * A post the provider has been unavailable to for about an hour (SPEC §8, §12): nothing is
 * lost and it resumes on its own, so the email says what is still useful, checking AWS's
 * status page and telling readers if the post can't wait, or, for a rate limit that has
 * outlasted any burst, the setting that causes it. It goes through the provider that is down,
 * so it says it may arrive late, and it is tried every few minutes until the provider takes it
 * or answers the send (`UNAVAILABLE_NOTICE_RETRY_MS`); the operator's Cloudflare alert is what
 * covers that gap.
 */
function unavailable(n: DueNotification, title: string, config: Config): RenderedEmail {
  const held = n.c_pending + n.c_in_flight;
  const throttled = isSelfThrottled(n);
  const readers =
    "If this post is time-sensitive, you may want to tell your readers it will be late.";
  return problem({
    subject: throttled
      ? `${title} is late: SES has refused it for its sending rate for over an hour`
      : `${title} is late: Amazon SES has been unavailable for over an hour`,
    happened: `${throttled ? "Amazon SES has refused every try for its sending rate" : "Amazon SES has been unavailable"} since ${when(n.halted_at ?? n.episode)}, so ${title} has been waiting for over an hour.`,
    affected: `${emails(held)} ${held === 1 ? "is" : "are"} still to go.`,
    said: said(n.halt_error),
    todo: throttled
      ? `This instance may be asking for more a second than the account allows. ${SES_RATE_ADVICE} ${PASS_THIS_ALONG} ${readers}`
      : `There’s nothing to fix in Kestrel. Check AWS’s status page (${AWS_STATUS_PAGE}) for a problem with Amazon SES in your region. ${readers}`,
    next: `Nothing is lost. It tries again every hour and carries on by itself as soon as SES answers, and any other post that comes due waits with it. ${NO_ONE_HARMED} Notifications go through SES too, so this email may have arrived late.`,
    link: { label: "See this send", url: sendLink(config, n.send_id) },
  });
}

/** Write the notification for one event, from the send as it stands now. */
export function composeNotification(n: DueNotification, config: Config): RenderedEmail {
  const link = { label: "See this send", url: sendLink(config, n.send_id) };
  const title = `"${n.subject}"`;
  switch (n.kind) {
    case "finished":
      return finished(n, title, config);
    case "refused":
      return refused(n, title, config);
    case "unavailable":
      return unavailable(n, title, config);
    case "stuck":
      return problem({
        subject: `${title} is waiting: nothing has gone out for ${minutes(STUCK_THRESHOLD_MS)} minutes`,
        happened: `Nothing has gone out for ${title} since ${when(n.progress_at ?? n.started_at ?? n.episode)}, and no provider problem explains it.`,
        affected: `${recipients(n.c_pending + n.c_in_flight)} ${n.c_pending + n.c_in_flight === 1 ? "is" : "are"} still waiting.`,
        todo: `If another post is going out, this one picks up once it finishes. Otherwise Kestrel’s once-a-minute sending job may have stopped or keep failing. ${CRON} ${PASS_THIS_ALONG}`,
        next: "You don’t need to restart it. It picks up where it stopped, mailing no one twice.",
        link,
      });
    case "wedged":
      return problem({
        subject: `${title} is waiting for you: ${recipients(n.c_in_flight)} to resolve`,
        happened: `Your email provider never answered for ${recipients(n.c_in_flight)} of ${title}.`,
        affected:
          "Kestrel can’t tell whether they got it, and sending again could mail them twice.",
        todo: "Open the send and choose Resolve. Unless you know otherwise, choose Assume not sent.",
        next: "Those readers may miss this post but get the next one, and no one is mailed twice. The send finishes once it’s resolved.",
        link: { ...link, label: "Resolve this send" },
      });
    case "missed":
      return problem({
        subject: `${title} is waiting: it didn’t go out on time`,
        happened: `${title} was due at ${when(n.fire_at)} and hasn’t gone out.`,
        todo: `Kestrel’s once-a-minute sending job has stopped or failed on it. ${CRON} ${PASS_THIS_ALONG}`,
        next: "It goes out as soon as that job runs again.",
        link,
      });
    case "no_receipts":
      return problem({
        subject: "Kestrel isn’t hearing back from Amazon SES",
        happened: `${NO_RECEIPTS_NOTICE_AFTER_MS / 3_600_000} hours after ${title} went out, Kestrel hasn’t heard back from Amazon SES about any of its emails.`,
        affected:
          "Its receipts may not be reaching Kestrel. If so, an address that bounces isn’t suppressed and a complaint doesn’t unsubscribe anyone, so your next post mails them again.",
        todo: `Look for webhook.refused in the logs, and check the provider’s event subscription, including that Deliveries is selected. ${PASS_THIS_ALONG}`,
        next: "This clears once any receipt arrives. You’re told once.",
        link,
      });
  }
}

/** A sample, for the settings surface's test, so the channel can be proved before a send runs into a problem. */
export function sampleNotification(config: Config): RenderedEmail {
  return done({
    subject: "Test: notifications from Kestrel",
    happened: "If you’re reading this, notifications reach this address. Nothing else was sent.",
    more: "Kestrel writes here when a post finishes sending, and right away if something needs attention.",
    link: {
      label: "Open Settings",
      url: dashboardLink(config.appOrigin, settingsRoute("notifications")),
    },
  });
}

/**
 * Tell the publisher the SES sandbox refused a signup's confirmation (SPEC §7, §8): the reader
 * was told a link is on its way and none went, and every signup from an address not verified
 * in SES meets the same until AWS grants production access. Sent at most once a UTC day, and
 * naming no reader.
 */
export function composeSandboxNotification(config: Config): RenderedEmail {
  return problem({
    subject: "A reader couldn’t sign up: SES is still in the sandbox",
    happened:
      "Someone signed up, but Amazon SES refused to send their confirmation email. Your SES account is still in the sandbox, which mails only addresses verified in SES.",
    affected:
      "The reader was told a link is on its way, so they may try again. Until this changes, every signup from an unverified address is refused the same way, and a post reaches only verified addresses.",
    todo: `Request production access on the SES console’s account dashboard. ${PASS_THIS_ALONG}`,
    next: "You’re told at most once a day until then.",
    link: { label: "Open the dashboard", url: dashboardLink(config.appOrigin, "/") },
  });
}

/**
 * Tell the publisher email isn't going out (SPEC §8): the provider refuses the account, whether
 * a post, a reader's signup, or the account check met it. Written from the refusal and the posts
 * it holds as they stand when it goes, it names no reader. An outage sends at most two: this,
 * and once more with the same words when a post is first held after one that named none. It
 * goes through the provider only when the deployment has no other channel, and then can't
 * arrive while the refusal lasts, so it says it may be late and the editor says it too.
 */
export function composeOutageNotification(
  refusal: SendingRefusal,
  since: number,
  heldSubjects: string[],
  config: Config,
): RenderedEmail {
  const posts = heldSubjects.map((s) => `"${s}"`);
  const first = posts[0];
  const link = { label: "Open the dashboard", url: dashboardLink(config.appOrigin, "/") };
  const happened =
    refusal.found_by === "account_check"
      ? `Kestrel’s check of your SES account found at ${when(since)} that SES will refuse every email.`
      : `Amazon SES started refusing your email at ${when(since)}.`;
  if (!first) {
    return problem({
      subject: "Email isn’t going out, and signups are paused",
      happened,
      affected: "Signups are paused, and any post that comes due will wait.",
      said: said(refusal.error),
      todo: refusal.advice,
      next: "Then send a test email from the Template screen. When SES takes it, signups reopen.",
      link,
    });
  }
  const one = posts.length === 1;
  const waiting = one ? `${first} is waiting` : `${posts.length} posts are waiting`;
  // Every notification goes through the provider, so this one can be held up with the rest.
  const late = " This email can be held up by the same problem, so it may be fixed already.";
  return problem({
    subject: `Email isn’t going out, and ${waiting}`,
    happened,
    affected: `Nothing can go out until it’s fixed: ${one ? waiting : `${posts.slice(0, -1).join(", ")} and ${posts.at(-1)} are waiting`}, and signups are paused.`,
    said: said(refusal.error),
    todo: refusal.advice,
    next: `Once it’s fixed, ${one ? `${first} carries on by itself` : "they carry on by themselves"} within the hour, and any other post that comes due waits with ${one ? "it" : "them"}. To reopen signups right away, send a test email from the Template screen. ${NO_ONE_HARMED}${late}`,
    link,
  });
}
