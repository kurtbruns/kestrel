/** Public, token-scoped reader routes: subscribe, confirm, unsubscribe. */

import * as subscribers from "../db/subscribers";
import { isValidEmail, normalizeEmail } from "../db/subscribers";
import { json } from "../lib/errors";
import { escapeHtml } from "../lib/html";
import { htmlPage, readerPage } from "../lib/page";
import type { RequestContext } from "../router";
import { requestSubscription } from "../services/subscriptions";
import { readerIdentity } from "./archive";

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
  identity: Awaited<ReturnType<typeof readerIdentity>>,
  mainHtml: string,
  status = 200,
): Response {
  return readerPage({
    identity,
    homeUrl: `${c.config.appOrigin}/`,
    title: `Subscribe · ${identity.name}`,
    mainHtml,
    status,
  });
}

export async function subscribeForm(c: RequestContext): Promise<Response> {
  const identity = await readerIdentity(c, c.config);
  const lede = identity.tagline
    ? escapeHtml(identity.tagline)
    : "Get the next issue delivered to your inbox.";
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
  const { subscriber, action } = await requestSubscription(c, email);
  if (!wantsHtml(c)) {
    return json({ status: subscriber.status, action });
  }
  const identity = await readerIdentity(c, c.config);
  const [heading, lead] =
    action === "already_confirmed"
      ? ["You’re already subscribed", `You’re on the list for ${escapeHtml(identity.name)}.`]
      : ["Almost there", "Check your inbox for a confirmation link to finish subscribing."];
  const main = `<p class="r-ey">Newsletter</p><h1 class="r-h1">${heading}</h1><p class="r-lead">${lead}</p>`;
  return subscribePage(c, identity, main);
}

export async function confirm(c: RequestContext): Promise<Response> {
  const token = c.url.searchParams.get("token") ?? "";
  const row = await subscribers.confirm(c.env.DB, token);
  if (!row) {
    return htmlPage(
      "Invalid link",
      `<h1 style="margin-top:0;">This link is invalid or expired</h1><p>Try subscribing again.</p>`,
      400,
    );
  }
  return htmlPage(
    "Subscribed",
    `<h1 style="margin-top:0;">You're subscribed 🎉</h1><p>Thanks for confirming <strong>${escapeHtml(
      row.email,
    )}</strong>. You'll hear from us soon.</p>`,
  );
}

export async function unsubscribeLanding(c: RequestContext): Promise<Response> {
  const token = c.url.searchParams.get("token") ?? "";
  const row = await subscribers.getByUnsubToken(c.env.DB, token);
  if (!row) {
    return htmlPage("Invalid link", `<h1 style="margin-top:0;">This link is invalid</h1>`, 400);
  }
  if (row.status === "unsubscribed") {
    return htmlPage(
      "Unsubscribed",
      `<h1 style="margin-top:0;">You're unsubscribed</h1><p>${escapeHtml(row.email)} won't receive further emails.</p>`,
    );
  }
  return htmlPage(
    "Unsubscribe",
    `<h1>Unsubscribe?</h1><p>Stop sending the newsletter to <strong>${escapeHtml(
      row.email,
    )}</strong>?</p>
<form method="post" action="/unsubscribe?token=${encodeURIComponent(token)}">
<button type="submit" class="btn btn-danger">Unsubscribe</button>
</form>`,
  );
}

export async function unsubscribe(c: RequestContext): Promise<Response> {
  const token = await readToken(c);
  const row = await subscribers.unsubscribeByToken(c.env.DB, token);
  if (!row) {
    return wantsHtml(c)
      ? htmlPage("Invalid link", `<h1 style="margin-top:0;">This link is invalid</h1>`, 400)
      : new Response("invalid token", { status: 400 });
  }
  // Plain 200 for the RFC 8058 one-click POST; a friendly page for humans.
  return wantsHtml(c)
    ? htmlPage(
        "Unsubscribed",
        `<h1 style="margin-top:0;">You've been unsubscribed</h1><p>${escapeHtml(row.email)} won't receive further emails.</p>`,
      )
    : new Response("unsubscribed", { status: 200 });
}
