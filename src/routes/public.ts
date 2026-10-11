/** Public, token-scoped reader routes: subscribe, confirm, unsubscribe. */

import { isValidEmail, normalizeEmail } from "../../shared/email";
import type { PublicSubscribeResponse } from "../../shared/subscribers";
import * as subscribers from "../db/subscribers";
import { json } from "../lib/errors";
import { escapeHtml, escapeHtmlAttr } from "../lib/html";
import { log } from "../lib/log";
import { archiveLink, type ReaderIdentity, readerPage } from "../lib/page";
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

/** The email field + submit + fine print, shared by the form and the retry-on-error
 *  page. Posts same-origin to `/subscribe`; the double opt-in starts from there (I1). */
function subscribeFormHtml(): string {
  return (
    `<form class="r-form" method="post" action="/subscribe">` +
    `<input type="email" name="email" required placeholder="you@example.com" aria-label="Your email address">` +
    `<button class="r-btn" type="submit">Subscribe</button></form>` +
    `<p class="r-fine">Double opt-in — we’ll email a confirmation link to finish. Unsubscribe anytime.</p>`
  );
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
    title: `Subscribe · ${identity.name}`,
    mainHtml,
    devDashboardUrl: devDashboardUrl(c.config),
    status,
  });
}

export async function subscribeForm(c: RequestContext): Promise<Response> {
  const identity = await readerIdentity(c, c.config);
  const lede = identity.tagline
    ? escapeHtml(identity.tagline)
    : "Get the next post delivered to your inbox.";
  const main =
    `<p class="r-ey">Newsletter</p>` +
    `<h1 class="r-h1">Subscribe to ${escapeHtml(identity.name)}</h1>` +
    `<p class="r-lead">${lede}</p>` +
    subscribeFormHtml();
  return subscribePage(c, identity, main);
}

export async function subscribe(c: RequestContext): Promise<Response> {
  const raw = await readEmail(c);
  const email = raw ? normalizeEmail(raw) : "";
  if (!email || !isValidEmail(email)) {
    if (!wantsHtml(c)) {
      return json({ error: "bad_request", message: "a valid email is required" }, 400);
    }
    const identity = await readerIdentity(c, c.config);
    const main =
      `<p class="r-ey">Newsletter</p>` +
      `<h1 class="r-h1">That doesn’t look like an email</h1>` +
      `<p class="r-lead">Please check the address and try again.</p>` +
      subscribeFormHtml();
    return subscribePage(c, identity, main, 400);
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
  const identity = await readerIdentity(c, c.config);
  const main =
    `<p class="r-ey">Newsletter</p><h1 class="r-h1">Almost there</h1>` +
    `<p class="r-lead">If that address isn’t subscribed yet, a confirmation link is on its way. Check your inbox to finish subscribing.</p>`;
  return subscribePage(c, identity, main);
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
  return confirmStatePage(c, await confirmSubscription(c.env.DB, token), token);
}

async function confirmStatePage(
  c: RequestContext,
  state: ConfirmLinkState,
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
          headline: `Confirm your subscription to ${identity.name}`,
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
function unsubscribeInvalidPage(c: RequestContext): Promise<Response> {
  return readerMessage(c, {
    title: "Invalid link",
    eyebrow: "Unsubscribe",
    headline: "This link is invalid",
    ledeHtml:
      "It may be incomplete. The unsubscribe link at the bottom of any email from the newsletter will work.",
    status: 400,
  });
}

/** The page once an address is off the list, whether it just left or already had. */
function unsubscribedPage(c: RequestContext, email: string): Promise<Response> {
  return readerMessage(c, {
    title: "Unsubscribed",
    eyebrow: "Unsubscribe",
    headline: "You’re unsubscribed",
    ledeHtml: `<strong>${escapeHtml(email)}</strong> won’t receive further emails.`,
  });
}

export async function unsubscribeLanding(c: RequestContext): Promise<Response> {
  const token = c.url.searchParams.get("token") ?? "";
  const row = await subscribers.getByUnsubToken(c.env.DB, token);
  if (!row) {
    return unsubscribeInvalidPage(c);
  }
  if (row.status === "unsubscribed") {
    return unsubscribedPage(c, row.email);
  }
  const identity = await readerIdentity(c, c.config);
  // The button wears the reader ink, not a danger red: leaving is what the reader came
  // here to do, and the reader palette has no alarm color.
  return readerMessage(
    c,
    {
      title: "Unsubscribe",
      eyebrow: "Unsubscribe",
      headline: `Unsubscribe from ${identity.name}?`,
      ledeHtml: `We’ll stop sending the newsletter to <strong>${escapeHtml(row.email)}</strong>.`,
      afterHtml:
        `<form class="r-form" method="post" action="/unsubscribe?token=${encodeURIComponent(token)}">` +
        `<button class="r-btn" type="submit">Unsubscribe</button></form>`,
    },
    identity,
  );
}

export async function unsubscribe(c: RequestContext): Promise<Response> {
  const token = await readToken(c);
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
