import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SERIF_STACK, serifStacksNamed } from "../shared/fonts";
import * as posts from "../src/db/posts";
import { DEFAULT_CONFIRMATION_EMAIL, updateSettings } from "../src/db/settings";
import { confirmationEmail } from "../src/emails/system";
import { getConfig } from "../src/env";
import { serverErrorPage, unavailablePage } from "../src/lib/page";
import { render } from "../src/render/render";
import { DEFAULT_EMAIL_TEMPLATE, defaultBranding } from "../src/render/template_engine";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { resetDatabase, seedConfirmed, sendingWorks } from "./support/fixtures";
import { AUTH, base } from "./support/http";

// One serif across the publication (SPEC §5, DESIGN §2): every surface the Worker writes names
// exactly the stack in shared/fonts.ts, so a page, the post it shows, and the email that post
// went out as can't drift apart. The editor's starting templates, its subscribe embed, and its
// stylesheet are held to the same in client/settings/fonts.spec.ts.

/** Every serif stack `text` names is the app's, and it names at least one. */
function expectOnlyTheAppSerif(text: string, where: string): void {
  const stacks = serifStacksNamed(text);
  expect(stacks.length, where).toBeGreaterThan(0);
  expect(new Set(stacks), where).toEqual(new Set([SERIF_STACK]));
}

beforeEach(async () => {
  await resetDatabase();
  await sendingWorks();
  await updateSettings(env.DB, { publication: { name: "Field Notes", tagline: "Birds" } });
});

describe("the app's serif", () => {
  it("is the one every reader page names, the post page's masthead and frozen post included (§5)", async () => {
    await seedConfirmed("a@example.com");
    const { post } = await posts.createPost(
      env.DB,
      { subject: "Kestrels", markdown: "# Kestrels\n\n## Hovering\n\nThey hang in the wind." },
      "test",
    );
    await freeze(env, getConfig(env), post, Date.now() - 1000);
    await sweep(env);
    const pages: Array<[string, RequestInit?]> = [
      ["/"],
      ["/archive"],
      [`/archive/${post.slug}`],
      ["/archive/no-such-post"],
      ["/subscribe"],
      ["/confirm?token=nope"],
      ["/unsubscribe?token=nope"],
      [`/api/posts/${post.id}/web`, { headers: AUTH }],
    ];
    for (const [path, init] of pages) {
      const res = await SELF.fetch(`${base}${path}`, init);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expectOnlyTheAppSerif(await res.text(), path);
    }
    expectOnlyTheAppSerif(await serverErrorPage().text(), "server error page");
    expectOnlyTheAppSerif(await unavailablePage().text(), "unavailable page");
  });

  it("is the one the built-in template names, and so every email rendered from it (I5)", async () => {
    expectOnlyTheAppSerif(DEFAULT_EMAIL_TEMPLATE, "built-in template");
    const { html } = await render(
      {
        post: { subject: "Kestrels", unlisted_token: "tok" } as never,
        revision: { markdown: "# Kestrels\n\nThey hang in the wind.", metadata: "{}" } as never,
        images: [],
      },
      getConfig(env),
      { ...defaultBranding(), name: "Field Notes" },
    );
    expectOnlyTheAppSerif(html, "rendered email");
  });

  it("is the one the confirmation email's masthead names (§7)", () => {
    const { html } = confirmationEmail(
      "https://a.example/confirm?token=t",
      DEFAULT_CONFIRMATION_EMAIL,
      {
        name: "Field Notes",
        tagline: "Birds",
        logoUrl: "",
      },
    );
    expectOnlyTheAppSerif(html, "confirmation email");
  });
});
