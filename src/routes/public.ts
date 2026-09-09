/** Public, token-scoped reader routes: subscribe, confirm, unsubscribe. */
import type { RequestContext } from "../router";
import { json } from "../lib/errors";
import { htmlPage } from "../lib/page";
import { escapeHtml } from "../lib/html";
import * as subscribers from "../db/subscribers";
import { isValidEmail, normalizeEmail } from "../db/subscribers";
import { requestSubscription } from "../services/subscriptions";

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
  if (q) return q;
  const ct = c.req.headers.get("content-type") ?? "";
  if (ct.includes("form")) {
    try {
      const f = await c.req.formData();
      const v = f.get("token");
      if (typeof v === "string") return v;
    } catch {
      /* ignore */
    }
  }
  return "";
}

export async function subscribeForm(_c: RequestContext): Promise<Response> {
  return htmlPage(
    "Subscribe",
    `<h1>Subscribe</h1>
<form method="post" action="/subscribe">
<input type="email" name="email" required placeholder="you@example.com">
<button type="submit" class="btn">Subscribe</button>
</form>`,
  );
}

export async function subscribe(c: RequestContext): Promise<Response> {
  const raw = await readEmail(c);
  const email = raw ? normalizeEmail(raw) : "";
  if (!email || !isValidEmail(email)) {
    return wantsHtml(c)
      ? htmlPage("Subscribe", `<h1>That doesn't look like an email</h1><p>Please check the address and try again.</p>`, 400)
      : json({ error: "bad_request", message: "a valid email is required" }, 400);
  }
  const { subscriber, action } = await requestSubscription(c, email);
  const msg =
    action === "already_confirmed"
      ? "You're already subscribed."
      : "Almost there — check your inbox for a confirmation link.";
  return wantsHtml(c)
    ? htmlPage("Subscribe", `<h1 style="margin-top:0;">Thanks!</h1><p>${msg}</p>`)
    : json({ status: subscriber.status, action });
}

export async function confirm(c: RequestContext): Promise<Response> {
  const token = c.url.searchParams.get("token") ?? "";
  const row = await subscribers.confirm(c.env.DB, token);
  if (!row) {
    return htmlPage("Invalid link", `<h1 style="margin-top:0;">This link is invalid or expired</h1><p>Try subscribing again.</p>`, 400);
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
  const row = await subscribers.getByToken(c.env.DB, token);
  if (!row) {
    return htmlPage("Invalid link", `<h1 style="margin-top:0;">This link is invalid</h1>`, 400);
  }
  if (row.status === "unsubscribed") {
    return htmlPage("Unsubscribed", `<h1 style="margin-top:0;">You're unsubscribed</h1><p>${escapeHtml(row.email)} won't receive further emails.</p>`);
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
    ? htmlPage("Unsubscribed", `<h1 style="margin-top:0;">You've been unsubscribed</h1><p>${escapeHtml(row.email)} won't receive further emails.</p>`)
    : new Response("unsubscribed", { status: 200 });
}
