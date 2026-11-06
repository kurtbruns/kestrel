import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as sends from "../src/db/sends";
import { DEFAULT_CONFIRMATION_EMAIL } from "../src/db/settings";
import { confirmationEmail } from "../src/emails/system";
import type { Config } from "../src/env";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { render } from "../src/render/render";
import { defaultBranding } from "../src/render/template_engine";
import { sweep } from "../src/send/sweep";
import { dueSend, frozenSend, resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";

// An email's side padding on a narrow display: what the render produces, every path that
// carries it, what it leaves alone, and the confirmation email's frame, which copies a
// post's. Each string is written out rather than imported from the shell, so moving a number
// or dropping the rule here fails.

/** The rule as the final HTML must carry it, outside any inlined style. */
const NARROW_RULE =
  "@media (max-width:560px) { .k-pad { padding-left:12px !important; padding-right:12px !important; } }";
/** The outer cell, whose inline side padding (12px) stays at every width. */
const OUTER_CELL = '<td align="center" style="padding:8px 12px 48px;">';
/** The inner cell whole: the rule's target, its inline values today's 32px. */
const INNER_CELL =
  '<td class="k-pad" style="padding:24px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#18181b;word-break:break-word;">';
/** The same cell in a copy frozen before the rule. */
const OLDER_INNER_CELL = INNER_CELL.replace(' class="k-pad"', "");

const config = { mediaPublicBase: "https://media.example" } as Config;

const renderPost = (template?: string) =>
  render(
    {
      post: { subject: "Subject", unlisted_token: "tok" } as never,
      revision: { markdown: "# Hi\n\nbody", metadata: "{}" } as never,
      images: [],
    },
    config,
    { ...defaultBranding(), ...(template ? { template } : {}) },
  );

/** A copy as a release before the rule froze it. */
const beforeTheRule = (html: string): string => {
  const older = html.replace(NARROW_RULE, "").replace(' class="k-pad"', "");
  expect(older).not.toBe(html);
  return older;
};

async function makeDraft(): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/api/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject: "Narrow", markdown: "# Hi\n\nbody" }),
    }),
  );
  return created.post.id;
}

async function postTest(id: string, to: string): Promise<string> {
  const res = await SELF.fetch(`${base}/api/posts/${id}/test`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ to }),
  });
  expect(res.status).toBe(200);
  const sent = fakeOutbox().find((m) => m.to === to);
  // A 200 can still mean it wasn't sent, and an empty string contains no rule either.
  expect(sent).toBeDefined();
  return sent!.html;
}

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
});

describe("the confirmation email's frame", () => {
  const CONFIRMATION_RULE =
    "@media (max-width:560px) { .k-sys-body { padding-left:12px !important; padding-right:12px !important; } }";
  const BODY_CELL =
    '<td class="k-sys-body" style="padding:24px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#18181b;">';
  const COLUMN =
    '<table role="presentation" width="664" cellpadding="0" cellspacing="0" class="k-sys-bg" style="max-width:664px;width:100%;background:#ffffff;">';

  it("matches a post's page, column, and padding, with no card", async () => {
    const { html } = confirmationEmail(`${base}/confirm?token=abc123`, DEFAULT_CONFIRMATION_EMAIL, {
      name: "",
      tagline: "",
      logoUrl: "",
    });
    // The same outer cell and column width as a post's own render, read from that render.
    const post = (await renderPost()).html;
    expect(post).toContain(OUTER_CELL);
    expect(html).toContain(OUTER_CELL);
    expect(post).toContain('width="664"');
    expect(html).toContain(COLUMN);
    // A white page in light, and the page's one color in dark, as a post has.
    expect(html).toContain(
      '<body class="k-sys-bg" style="margin:0;padding:0;background:#ffffff;">',
    );
    expect(html).toContain(".k-sys-bg { background:#18181b !important; }");
    // None of the card or its gray page is left.
    for (const gone of ["k-sys-card", "#f4f4f5", "#232327", "border-radius:8px"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("matches a post's 24px a side where the rule applies, over the same 44px inline", () => {
    const { html } = confirmationEmail(`${base}/confirm?token=abc123`, DEFAULT_CONFIRMATION_EMAIL, {
      name: "",
      tagline: "",
      logoUrl: "",
    });
    // The rule lands in the head, where a client that keeps <style> reads it…
    expect(html.indexOf(CONFIRMATION_RULE)).toBeGreaterThan(html.indexOf("<head>"));
    expect(html.indexOf(CONFIRMATION_RULE)).toBeLessThan(html.indexOf("</head>"));
    // …and a client that drops <style> shows the inline values: 12px outside, 32px inside.
    expect(html).toContain(OUTER_CELL);
    expect(html).toContain(BODY_CELL);
    // The class that takes the rule is on that one cell. The masthead's name and the body
    // copy take other classes, so nothing else moves.
    expect(html.split('class="k-sys-body"').length - 1).toBe(1);
  });
});

describe("the email's side padding on a narrow display", () => {
  it("carries a rule through the inliner that brings the padding to 24px a side, over today's inline values", async () => {
    const { html } = await renderPost();
    // The rule lands in the head, where a client that keeps <style> reads it…
    expect(html.indexOf(NARROW_RULE)).toBeGreaterThan(html.indexOf("<head>"));
    expect(html.indexOf(NARROW_RULE)).toBeLessThan(html.indexOf("</head>"));
    // …and a client that drops <style> shows the inline values as they were: 44px a side.
    expect(html).toContain(OUTER_CELL);
    expect(html).toContain(INNER_CELL);
    // The rule's class is on that one cell and nothing else.
    expect(html.split('class="k-pad"').length - 1).toBe(1);
    // The dark rule sits beside it, unchanged.
    expect(html).toContain("@media (prefers-color-scheme: dark) { .k-bg");
  });

  it("reaches a saved template, which is only what goes inside the shell", async () => {
    const saved =
      '<div style="padding:0 5px">{{ .Post.Body }}<a href="{{ .Email.UnsubscribeURL }}">Leave</a></div>';
    const { html } = await renderPost(saved);
    expect(html).toContain(NARROW_RULE);
    expect(html).toContain(OUTER_CELL);
    expect(html).toContain(INNER_CELL);
    // The template's own spacing is the publisher's, and stays.
    expect(html).toContain('<div style="padding:0 5px">');
  });

  it("is on the preview, the web version, a post test, and a template test (I5)", async () => {
    const id = await makeDraft();
    for (const path of [`/api/posts/${id}/preview`, `/api/posts/${id}/web`]) {
      const page = await SELF.fetch(`${base}${path}`, { headers: AUTH });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(NARROW_RULE);
    }
    expect(await postTest(id, "post-test@example.com")).toContain(NARROW_RULE);

    const res = await SELF.fetch(`${base}/api/settings/template/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to: "template-test@example.com" }),
    });
    expect(res.status).toBe(200);
    const sample = fakeOutbox().find((m) => m.to === "template-test@example.com");
    expect(sample?.html).toContain(NARROW_RULE);
  });

  it("is frozen with a send and delivered as frozen (I3)", async () => {
    await seedConfirmed("reader@example.com");
    const send = await dueSend();
    expect(send.rendered_html).toContain(NARROW_RULE);
    await sweep(env);
    const delivered = fakeOutbox().find((m) => m.to === "reader@example.com");
    expect(delivered?.html).toContain(NARROW_RULE);
    expect(delivered?.html).toContain(INNER_CELL);
  });

  it("leaves a send frozen before it alone, until the publisher re-makes it (SPEC §6)", async () => {
    const send = await frozenSend(Date.now() + 60 * 60 * 1000);
    const older = beforeTheRule(send.rendered_html);
    await env.DB.prepare("UPDATE sends SET rendered_html = ? WHERE id = ?")
      .bind(older, send.id)
      .run();

    // Nothing but a freeze moves it: a preview and a test of the scheduled post are the
    // frozen copy, under the shell this code would render today.
    const preview = await SELF.fetch(`${base}/api/posts/${send.post_id}/preview`, {
      headers: AUTH,
    });
    expect(preview.status).toBe(200);
    const previewed = await preview.text();
    expect(previewed).toContain(OLDER_INNER_CELL);
    expect(previewed).not.toContain(NARROW_RULE);
    const tested = await postTest(send.post_id, "frozen-test@example.com");
    expect(tested).toContain(OLDER_INNER_CELL);
    expect(tested).not.toContain(NARROW_RULE);
    const stillFrozen = await sends.getSend(env.DB, send.id);
    expect(stillFrozen?.rendered_html).toBe(older);

    // A confirmed template save is the deliberate act that re-makes it.
    const saved = await SELF.fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({
        email_template:
          '<div>{{ .Post.Body }}<a href="{{ .Email.UnsubscribeURL }}">Leave</a></div>',
        remake: [send.id],
      }),
    });
    expect(saved.status).toBe(200);
    const remade = await sends.getSend(env.DB, send.id);
    expect(remade?.rendered_html).toContain(NARROW_RULE);
  });

  it("leaves a send frozen before it alone when it fires, and on its page (I3)", async () => {
    await seedConfirmed("reader@example.com");
    const send = await dueSend();
    const older = beforeTheRule(send.rendered_html);
    await env.DB.prepare("UPDATE sends SET rendered_html = ? WHERE id = ?")
      .bind(older, send.id)
      .run();

    await sweep(env);

    const delivered = fakeOutbox().find((m) => m.to === "reader@example.com");
    expect(delivered?.html).toContain(OLDER_INNER_CELL);
    expect(delivered?.html).not.toContain(NARROW_RULE);
    const page = await SELF.fetch(`${base}/api/posts/${send.post_id}/web`, { headers: AUTH });
    expect(page.status).toBe(200);
    const served = await page.text();
    expect(served).toContain(OLDER_INNER_CELL);
    expect(served).not.toContain(NARROW_RULE);
  });
});
