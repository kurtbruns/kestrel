/** Public, token-scoped reader routes: subscribe, confirm, unsubscribe. While no email
 *  provider is connected (SPEC §9), the subscribe page says signups aren't open yet and a
 *  subscribe request is refused, the same way for every address. */

import { isValidEmail, normalizeEmail } from "../../shared/email";
import type { PublicSubscribeResponse } from "../../shared/subscribers";
import * as subscribers from "../db/subscribers";
import type { Config } from "../env";
import { json } from "../lib/errors";
import { escapeHtml, escapeHtmlAttr } from "../lib/html";
import { log } from "../lib/log";
import {
  archiveLink,
  pageTitle,
  type ReaderBanner,
  type ReaderIdentity,
  readerPage,
  subscribeFormHtml,
} from "../lib/page";
import type { RequestContext } from "../router";
import {
  type ConfirmLinkState,
  confirmLinkState,
  confirmSubscription,
  requestSubscription,
} from "../services/subscriptions";
import { archiveHomeUrl, devDashboardUrl, readerIdentity, readerMessage } from "./reader";

function wantsHtml(c: RequestContext): boolean {
  const accept = c.req.headers.get("accept") ?? "";
  const ct = c.req.headers.get("content-type") ?? "";
  return (
    accept.includes("text/html") ||
    ct.includes("application/x-www-form-urlencoded") ||
    ct.includes("multipart/form-data")
  );
}

async function readEmail(c: RequestContext): Promise<string | null> {
  const ct = c.req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const b = (await c.req.json()) as { email?: unknown };
      return typeof b.email === "string" ? b.email : null;
    } catch {
      return null;
    }
  }
  if (ct.includes("form")) {
    const f = await c.req.formData();
    const v = f.get("email");
    return typeof v === "string" ? v : null;
  }
  return c.url.searchParams.get("email");
}

async function readToken(c: RequestContext): Promise<string> {
  const q = c.url.searchParams.get("token");
  if (q) {
    return q;
  }
  const ct = c.req.headers.get("content-type") ?? "";
  if (ct.includes("form")) {
    try {
      const f = await c.req.formData();
      const v = f.get("token");
      if (typeof v === "string") {
        return v;
      }
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** A headline that names the publication when it has a name ("Subscribe to Birds") and
 *  reads whole without one ("Subscribe"), so no page shows a name the publisher didn't
 *  choose (SPEC §9). */
function toPublication(action: string, name: string): string {
  return name ? `${action} to ${name}` : action;
}

/** Wrap a subscribe-flow body in the branded reader shell (no masthead CTA — the
 *  reader is already here). */
function subscribePage(
  c: RequestContext,
  identity: ReaderIdentity,
  mainHtml: string,
  status = 200,
): Response {
  return readerPage({
    identity,
    homeUrl: `${c.config.appOrigin}/`,
    title: pageTitle("Subscribe", identity.name),
    mainHtml,
    devDashboardUrl: devDashboardUrl(c.config),
    status,
  });
}

/** The subscribe form, in the identity given (Settings' preview passes its own read). */
export function subscribeFormPage(c: RequestContext, identity: ReaderIdentity): Response {
  const lede = identity.tagline
    ? escapeHtml(identity.tagline)
    : "Get the next post delivered to your inbox.";
  const main =
    `<p class="r-ey">Newsletter</p>` +
    `<h1 class="r-h1">${escapeHtml(toPublication("Subscribe", identity.name))}</h1>` +
    `<p class="r-lead">${lede}</p>` +
    subscribeFormHtml();
  return subscribePage(c, identity, main);
}

/** The form again, for an address that doesn't parse. */
export function subscribeNotAnEmailPage(c: RequestContext, identity: ReaderIdentity): Response {
  const main =
    `<p class="r-ey">Newsletter</p>` +
    `<h1 class="r-h1">That doesn’t look like an email</h1>` +
    `<p class="r-lead">Please check the address and try again.</p>` +
    subscribeFormHtml();
  return subscribePage(c, identity, main, 400);
}

/**
 * The subscribe page while no email provider is connected (SPEC §9): no form, since an
 * address taken now could not be sent its confirmation. Every request gets it alike, so it
 * says nothing about the list (§7).
 */
export function subscribeNotOpenPage(
  c: RequestContext,
  identity: ReaderIdentity,
  status = 200,
): Response {
  const main =
    `<p class="r-ey">Newsletter</p>` +
    `<h1 class="r-h1">Signups aren’t open yet</h1>` +
    `<p class="r-lead">This newsletter isn’t taking subscribers yet. Please check back soon.</p>`;
  return subscribePage(c, identity, main, status);
}

/** Whether a subscribe would be taken: not while no email provider is connected (SPEC §9).
 *  The subscribe page and the empty home page both ask this, so they never disagree. */
export function signupsOpen(config: Config): boolean {
  return config.provider !== "none";
}

/** The one answer every subscribe request gets, whatever the address's state (SPEC §7). */
export function subscribeCheckInboxPage(c: RequestContext, identity: ReaderIdentity): Response {
  const main =
    `<p class="r-ey">Newsletter</p><h1 class="r-h1">Almost there</h1>` +
    `<p class="r-lead">If that address isn’t subscribed yet, a confirmation link is on its way. Check your inbox to finish subscribing.</p>`;
  return subscribePage(c, identity, main);
}

export async function subscribeForm(c: RequestContext): Promise<Response> {
  const identity = await readerIdentity(c, c.config);
  return signupsOpen(c.config) ? subscribeFormPage(c, identity) : subscribeNotOpenPage(c, identity);
}

export async function subscribe(c: RequestContext): Promise<Response> {
  if (!signupsOpen(c.config)) {
    // Refused before the address is read, so no address is stored or even looked at, and
    // every request gets the same answer (SPEC §7, §9). Logged, so the operator can see
    // readers arriving before signups are open.
    log.warn("subscribe.not_connected");
    if (!wantsHtml(c)) {
      return json(
        {
          error: "provider_not_connected",
          message: "This newsletter isn't taking subscribers yet.",
        },
        503,
      );
    }
    return subscribeNotOpenPage(c, await readerIdentity(c, c.config), 503);
  }
  const raw = await readEmail(c);
  const email = raw ? normalizeEmail(raw) : "";
  if (!email || !isValidEmail(email)) {
    if (!wantsHtml(c)) {
      return json({ error: "bad_request", message: "a valid email is required" }, 400);
    }
    return subscribeNotAnEmailPage(c, await readerIdentity(c, c.config));
  }
  // Subscribing, and any confirmation, happen after the answer has gone: the answer, and
  // how long it takes, must not depend on the address's state (SPEC §7). A refusal is
  // logged and changes nothing, so the reader can simply submit again.
  c.ctx.waitUntil(
    requestSubscription(c, email).catch((err: unknown) => {
      // The error's kind, not its text, which may carry the address being subscribed.
      log.error("subscribe.failed", { name: err instanceof Error ? err.name : typeof err });
    }),
  );
  // One answer for every address, so a request can't learn whether it is subscribed,
  // pending, suppressed, or new.
  if (!wantsHtml(c)) {
    const body: PublicSubscribeResponse = { status: "check_inbox" };
    return json(body);
  }
  return subscribeCheckInboxPage(c, await readerIdentity(c, c.config));
}

/** Opening a confirm link shows a Confirm button and changes nothing: mail scanners open
 *  every link in a message, and only the owner's click is consent (I1, SPEC §7). */
export async function confirmLanding(c: RequestContext): Promise<Response> {
  const token = c.url.searchParams.get("token") ?? "";
  return confirmStatePage(c, await confirmLinkState(c.env.DB, token), token);
}

/** The Confirm button's POST: the one request that records consent. */
export async function confirm(c: RequestContext): Promise<Response> {
  const token = await readToken(c);
  const ip = c.req.headers.get("cf-connecting-ip");
  return confirmStatePage(c, await confirmSubscription(c.env.DB, token, ip), token);
}

/** A confirm page's state: a link's state, or a preview's sample of one. */
export type ConfirmPageState =
  | { kind: "ready" | "confirmed" | "expired"; subscriber: { email: string } }
  | Extract<ConfirmLinkState, { kind: "invalid" }>;

/** The page a confirm link's state shows. Settings' preview passes a sample state. */
export async function confirmStatePage(
  c: RequestContext,
  state: ConfirmPageState,
  token: string,
): Promise<Response> {
  const eyebrow = "Newsletter";
  switch (state.kind) {
    case "ready": {
      // The consent step names whose list the reader is joining, so a link that opens
      // from an email can't read as anyone's.
      const identity = await readerIdentity(c, c.config);
      return readerMessage(
        c,
        {
          title: "Confirm your subscription",
          eyebrow,
          headline: toPublication("Confirm your subscription", identity.name),
          ledeHtml: `Start sending the newsletter to <strong>${escapeHtml(state.subscriber.email)}</strong>?`,
          afterHtml:
            `<form class="r-form" method="post" action="/confirm">` +
            `<input type="hidden" name="token" value="${escapeHtmlAttr(token)}">` +
            `<button class="r-btn" type="submit">Confirm subscription</button></form>`,
        },
        identity,
      );
    }
    case "confirmed":
      return readerMessage(c, {
        title: "Subscribed",
        eyebrow,
        headline: "You’re subscribed",
        ledeHtml: `Thanks for confirming <strong>${escapeHtml(state.subscriber.email)}</strong>. The next post will land in your inbox.`,
        afterHtml: archiveLink(archiveHomeUrl(c.config), "Browse the archive"),
      });
    case "expired":
      // A fresh link goes through the ordinary subscribe path, cooldown and all.
      return readerMessage(c, {
        title: "Link expired",
        eyebrow,
        headline: "This link has expired",
        ledeHtml: `Confirmation links only work for a limited time. We can send a new one to <strong>${escapeHtml(state.subscriber.email)}</strong>.`,
        afterHtml:
          `<form class="r-form" method="post" action="/subscribe">` +
          `<input type="hidden" name="email" value="${escapeHtmlAttr(state.subscriber.email)}">` +
          `<button class="r-btn" type="submit">Send a new link</button></form>`,
        status: 410,
      });
    case "invalid":
      return readerMessage(c, {
        title: "Invalid link",
        eyebrow,
        headline: "This link is invalid",
        ledeHtml: `<a href="/subscribe">Subscribe again</a> to get a new one.`,
        status: 400,
      });
  }
}

/** An unsubscribe link that matches no subscriber: most often one cut short when it
 *  was copied, so the page points at a link that works. */
export function unsubscribeInvalidPage(c: RequestContext): Promise<Response> {
  return readerMessage(c, {
    title: "Invalid link",
    eyebrow: "Unsubscribe",
    headline: "This link is invalid",
    ledeHtml:
      "It may be incomplete. The unsubscribe link at the bottom of any email from the newsletter will work.",
    status: 400,
  });
}

/** The page once an address is off the list, whether it just left or already had. A
 *  test walks through it too, with a sample address under the test banner. */
export function unsubscribedPage(
  c: RequestContext,
  email: string,
  banner?: ReaderBanner,
): Promise<Response> {
  return readerMessage(c, {
    title: "Unsubscribed",
    eyebrow: "Unsubscribe",
    headline: "You’re unsubscribed",
    ledeHtml: `<strong>${escapeHtml(email)}</strong> won’t receive further emails.`,
    banner,
  });
}

/** The page that asks before unsubscribing, its button posting to `action`. A test
 *  shows the same page with a sample address under the test banner. */
export async function unsubscribeAskPage(
  c: RequestContext,
  email: string,
  action: string,
  banner?: ReaderBanner,
): Promise<Response> {
  const identity = await readerIdentity(c, c.config);
  // The button wears the reader ink, not a danger red: leaving is what the reader came
  // here to do, and the reader palette has no alarm color.
  return readerMessage(
    c,
    {
      title: "Unsubscribe",
      eyebrow: "Unsubscribe",
      headline: identity.name ? `Unsubscribe from ${identity.name}?` : "Unsubscribe?",
      ledeHtml: `We’ll stop sending the newsletter to <strong>${escapeHtml(email)}</strong>.`,
      afterHtml:
        `<form class="r-form" method="post" action="${escapeHtmlAttr(action)}">` +
        `<button class="r-btn" type="submit">Unsubscribe</button></form>`,
      banner,
    },
    identity,
  );
}

/** The query the unsubscribe link of a test email or a preview carries in place of a
 *  subscriber's token: neither is a list send, so the link carries no subscriber's token
 *  and has no one to unsubscribe, even when a test goes to a subscribed address. Built
 *  here, beside the route that answers it, so the link they carry and the page it opens
 *  can't drift apart. */
const TEST_UNSUBSCRIBE_PARAM = "test";

/** The unsubscribe link a test email (post and template tests alike) and the editor's
 *  preview carry. */
export function testUnsubscribeUrl(config: Config): string {
  return `${config.appOrigin}/unsubscribe?${TEST_UNSUBSCRIBE_PARAM}=1`;
}

/** A request that carries the test marker and no token. A real token always wins, so
 *  the marker can never stand between a subscriber and leaving. */
function isTestUnsubscribe(c: RequestContext, token: string): boolean {
  return token === "" && c.url.searchParams.get(TEST_UNSUBSCRIBE_PARAM) === "1";
}

/** What a test shows in place of the recipient's address. Never the address the test
 *  went to: the link carries none, and putting one in a URL would leak it. */
const TEST_UNSUBSCRIBE_EMAIL = "reader@example.com";

/** The strip over every page a test's unsubscribe link walks through, so the real
 *  pages can be shown without anyone mistaking them for a real unsubscribe. */
const TEST_UNSUBSCRIBE_BANNER: ReaderBanner = {
  tag: "Test",
  text: "This is the page a subscriber sees. Nothing here changes anyone’s subscription.",
};

export async function unsubscribeLanding(c: RequestContext): Promise<Response> {
  const token = c.url.searchParams.get("token") ?? "";
  // A test or a preview opens the page a subscriber sees, so the publisher proofs the
  // real thing (SPEC §7), with a sample address and its button posting back as a test.
  if (isTestUnsubscribe(c, token)) {
    return unsubscribeAskPage(
      c,
      TEST_UNSUBSCRIBE_EMAIL,
      `/unsubscribe?${TEST_UNSUBSCRIBE_PARAM}=1`,
      TEST_UNSUBSCRIBE_BANNER,
    );
  }
  const row = await subscribers.getByUnsubToken(c.env.DB, token);
  if (!row) {
    return unsubscribeInvalidPage(c);
  }
  if (row.status === "unsubscribed") {
    return unsubscribedPage(c, row.email);
  }
  return unsubscribeAskPage(c, row.email, `/unsubscribe?token=${encodeURIComponent(token)}`);
}

export async function unsubscribe(c: RequestContext): Promise<Response> {
  const token = await readToken(c);
  // The test page's button, or a mail client's own Unsubscribe button on a test email
  // (RFC 8058). It changes nothing and answers as a success would: a person gets the
  // page a subscriber would, under the test banner, and a client reports no error.
  if (isTestUnsubscribe(c, token)) {
    return wantsHtml(c)
      ? unsubscribedPage(c, TEST_UNSUBSCRIBE_EMAIL, TEST_UNSUBSCRIBE_BANNER)
      : new Response("test email", { status: 200 });
  }
  const row = await subscribers.unsubscribeByToken(c.env.DB, token);
  if (!row) {
    return wantsHtml(c)
      ? unsubscribeInvalidPage(c)
      : new Response("invalid token", { status: 400 });
  }
  // Plain 200 for the RFC 8058 one-click POST; a friendly page for humans.
  return wantsHtml(c)
    ? unsubscribedPage(c, row.email)
    : new Response("unsubscribed", { status: 200 });
}
