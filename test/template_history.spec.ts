import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getSettings, updateSettings } from "../src/db/settings";
import {
  getTemplateRevision,
  insertTemplateRevisionStmt,
  listTemplateRevisions,
} from "../src/db/template_revisions";
import { SEND_NOW_BUFFER_MS } from "../src/lib/time";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { sweep } from "../src/send/sweep";
import {
  currentTemplateRevision,
  saveTemplate as saveTemplateDirect,
} from "../src/services/template_history";
import { adminAuth } from "./support/auth";

// One template, with history, pinned per send (SPEC §2, §6, §8, §9): every save writes a
// template revision; a send records the one it was made with; making a post again after
// the template changed needs an explicit choice; a save reports the scheduled sends it
// leaves alone, and each can be updated in place; any revision can be restored.

const AUTH = await adminAuth();
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

/** A valid template carrying a marker so a frozen render can be traced to its revision. */
const tpl = (marker: string) =>
  `<div class="${marker}">{{ post.body }}<a href="{{ email.unsubscribeUrl }}">Unsubscribe</a></div>`;

async function saveTemplate(html: string): Promise<any> {
  const res = await SELF.fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: JSON_AUTH,
    body: JSON.stringify({ emailTemplate: html }),
  });
  expect(res.status).toBe(200);
  return readJson(res);
}

async function makeDraft(markdown = "# Hi\n\nbody"): Promise<string> {
  const created = await readJson(
    await SELF.fetch(`${base}/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject: "The Subject", markdown }),
    }),
  );
  return created.post.id;
}

const future = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

async function schedule(postId: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return SELF.fetch(`${base}/posts/${postId}/schedule`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ fire_at: future(30 * 60 * 1000), ...extra }),
  });
}

async function cancel(sendId: string): Promise<void> {
  const res = await SELF.fetch(`${base}/sends/${sendId}/cancel`, { method: "POST", headers: AUTH });
  expect(res.status).toBe(200);
}

const getPost = async (id: string) =>
  readJson(await SELF.fetch(`${base}/posts/${id}`, { headers: AUTH }));
const getSend = async (id: string) =>
  readJson(await SELF.fetch(`${base}/sends/${id}`, { headers: AUTH }));
const getTemplate = async () =>
  (await readJson(await SELF.fetch(`${base}/api/settings`, { headers: AUTH }))).template;

describe("the template has a history", () => {
  it("records the initial template as revision one on first read, so every send pins a revision that exists", async () => {
    // A fresh database: no revision yet, a blank (= built-in) template.
    expect(await listTemplateRevisions(env.DB)).toHaveLength(0);
    const template = await getTemplate();
    expect(typeof template.revision).toBe("string");
    expect(typeof template.saved_at).toBe("number");
    const rows = await listTemplateRevisions(env.DB);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(template.revision);
    expect(rows[0]!.author).toBeNull();
    // The settings blob points at it and mirrors its html (the built-in default).
    const s = await getSettings(env.DB);
    expect(s.emailTemplateRevision).toBe(template.revision);
    expect(s.emailTemplate).toContain("{{ post.body }}");
    // A second read records nothing more.
    expect((await getTemplate()).revision).toBe(template.revision);
    expect(await listTemplateRevisions(env.DB)).toHaveLength(1);
  });

  it("two first uses at once record one revision, not two", async () => {
    // A fresh database (this file's first test recorded revision one; take it back out).
    await env.DB.batch([
      env.DB.prepare("DELETE FROM template_revisions"),
      env.DB.prepare("DELETE FROM settings"),
    ]);
    const [a, b] = await Promise.all([
      currentTemplateRevision(env.DB),
      currentTemplateRevision(env.DB),
    ]);
    expect(a.id).toBe(b.id);
    expect(await listTemplateRevisions(env.DB)).toHaveLength(1);
    expect((await getSettings(env.DB)).emailTemplateRevision).toBe(a.id);
  });

  it("a save writes a template revision and makes it current", async () => {
    const before = await getTemplate();
    const saved = await saveTemplate(tpl("v2"));
    expect(saved.template.revision).not.toBe(before.revision);
    expect(saved.template.saved_at).toBeGreaterThanOrEqual(before.saved_at);
    expect(saved.scheduled_posts_kept).toEqual([]);
    expect((await getTemplate()).revision).toBe(saved.template.revision);

    const list = await readJson(
      await SELF.fetch(`${base}/api/settings/template/revisions`, { headers: AUTH }),
    );
    expect(list.current.revision).toBe(saved.template.revision);
    expect(list.revisions.map((r: any) => r.id)).toEqual([
      saved.template.revision,
      before.revision,
    ]);
    expect(list.revisions[0].is_current).toBe(true);
    expect(list.revisions[0].author).toBe("tester@example.com");
    expect(list.revisions[1].is_current).toBe(false);
    // The history carries no html — the current html is on the settings surface.
    expect(list.revisions[0]).not.toHaveProperty("html");
  });

  it("a save of the template that is already current records nothing", async () => {
    const saved = await saveTemplate(tpl("same"));
    const again = await saveTemplate(tpl("same"));
    expect(again.template.revision).toBe(saved.template.revision);
    const rows = await listTemplateRevisions(env.DB);
    expect(rows.map((r) => r.id)).toContain(saved.template.revision);
    // Exactly one row holds these bytes — the second save added none.
    const htmls = await Promise.all(
      rows.map(async (r) => (await getTemplateRevision(env.DB, r.id))!.html),
    );
    expect(htmls.filter((h) => h === tpl("same"))).toHaveLength(1);
  });

  it("a template save and a preference save at the same moment both land", async () => {
    // Two writers on the one settings row: the template writer's revision must end up
    // current AND the preference must survive, whichever committed first.
    const marker = `race-${Date.now()}`;
    const [pref, saved] = await Promise.all([
      updateSettings(env.DB, { publication: { tagline: marker } }),
      saveTemplateDirect(env.DB, tpl(marker), "tester@example.com"),
    ]);
    expect(pref.publication.tagline).toBe(marker);
    const s = await getSettings(env.DB);
    expect(s.publication.tagline).toBe(marker);
    expect(s.emailTemplateRevision).toBe(saved.revision.id);
    expect(s.emailTemplate).toBe(tpl(marker));
  });

  it("a save with other preferences alongside an invalid template writes neither", async () => {
    const before = await getTemplate();
    const res = await SELF.fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: JSON_AUTH,
      body: JSON.stringify({
        publication: { name: "Should not land" },
        emailTemplate: "<div>{{ post.body }}</div>", // no unsubscribe link
      }),
    });
    expect(res.status).toBe(400);
    expect((await getTemplate()).revision).toBe(before.revision);
    expect((await getSettings(env.DB)).publication.name).not.toBe("Should not land");
  });
});

describe("a send pins the template revision it was made with", () => {
  it("a first schedule uses the current template with no prompt, and the send records it", async () => {
    const saved = await saveTemplate(tpl("first"));
    const id = await makeDraft();
    // Never made before: the facts say so, and no choice is asked.
    const facts = (await getPost(id)).template;
    expect(facts.current.revision).toBe(saved.template.revision);
    expect(facts.last_made_with).toBeNull();
    expect(facts.changed_since_last_made).toBe(false);

    const res = await schedule(id);
    expect(res.status).toBe(201);
    const { send } = await readJson(res);
    expect(send.template_revision).toBe(saved.template.revision);
    expect(send.rendered_html).toContain('class="first"');

    // The post now reports the active send's revision as well as the facts.
    const after = await getPost(id);
    expect(after.scheduled.id).toBe(send.id);
    expect(after.scheduled.template.revision).toBe(saved.template.revision);
    expect(after.template.last_made_with.revision).toBe(saved.template.revision);
    expect(after.template.changed_since_last_made).toBe(false);
  });

  it("a first schedule needs no prompt even if the template changed many times before it (drafts are live)", async () => {
    const id = await makeDraft();
    await saveTemplate(tpl("a"));
    await saveTemplate(tpl("b"));
    const latest = await saveTemplate(tpl("c"));
    const res = await schedule(id);
    expect(res.status).toBe(201);
    expect((await readJson(res)).send.template_revision).toBe(latest.template.revision);
  });

  it("send-now pins the current template too", async () => {
    const saved = await saveTemplate(tpl("now"));
    const id = await makeDraft();
    const res = await SELF.fetch(`${base}/posts/${id}/send`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(201);
    expect((await readJson(res)).send.template_revision).toBe(saved.template.revision);
  });
});

describe("making a post again after the template changed needs an explicit choice", () => {
  /** A post scheduled under revision `old`, then canceled, then the template saved as `new`. */
  async function madeThenChanged() {
    const old = await saveTemplate(tpl("old"));
    const id = await makeDraft();
    const first = (await readJson(await schedule(id))).send;
    await cancel(first.id);
    const current = await saveTemplate(tpl("new"));
    return { id, old: old.template, current: current.template };
  }

  it("the post reports the change, and a schedule without template_revision is refused (409)", async () => {
    const { id, old, current } = await madeThenChanged();
    const facts = (await getPost(id)).template;
    expect(facts.last_made_with.revision).toBe(old.revision);
    expect(facts.current.revision).toBe(current.revision);
    expect(facts.changed_since_last_made).toBe(true);

    const res = await schedule(id);
    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(body.error).toBe("template_choice_required");
    expect(body.message).toMatch(/template_revision/);
    expect(body.template.last_made_with.revision).toBe(old.revision);
    expect(body.template.current.revision).toBe(current.revision);
    // Nothing was frozen: still a draft with no active send.
    expect((await getPost(id)).post.status).toBe("draft");
  });

  it("send-now is refused the same way", async () => {
    const { id } = await madeThenChanged();
    const res = await SELF.fetch(`${base}/posts/${id}/send`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("template_choice_required");
  });

  it("naming the revision the post had keeps its look (the old template renders)", async () => {
    const { id, old } = await madeThenChanged();
    const res = await schedule(id, { template_revision: old.revision });
    expect(res.status).toBe(201);
    const { send } = await readJson(res);
    expect(send.template_revision).toBe(old.revision);
    expect(send.rendered_html).toContain('class="old"');
    expect(send.rendered_html).not.toContain('class="new"');
  });

  it("naming the current revision takes the new look", async () => {
    const { id, current } = await madeThenChanged();
    const res = await schedule(id, { template_revision: current.revision });
    expect(res.status).toBe(201);
    const { send } = await readJson(res);
    expect(send.template_revision).toBe(current.revision);
    expect(send.rendered_html).toContain('class="new"');
  });

  it("send-now accepts the choice in its body", async () => {
    const { id, old } = await madeThenChanged();
    const res = await SELF.fetch(`${base}/posts/${id}/send`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ template_revision: old.revision }),
    });
    expect(res.status).toBe(201);
    expect((await readJson(res)).send.template_revision).toBe(old.revision);
  });

  it("any other revision id is refused (409), even a real one from the history", async () => {
    const { id } = await madeThenChanged();
    const stranger = await saveTemplate(tpl("stranger")); // now current; the choice below is stale
    const newer = await saveTemplate(tpl("newer"));
    expect(newer.template.revision).not.toBe(stranger.template.revision);
    for (const template_revision of [stranger.template.revision, "not-a-revision", ""]) {
      const res = await schedule(id, { template_revision });
      expect(res.status, template_revision).toBeGreaterThanOrEqual(400);
      expect((await getPost(id)).post.status).toBe("draft");
    }
    const stale = await schedule(id, { template_revision: stranger.template.revision });
    expect(stale.status).toBe(409);
    expect((await readJson(stale)).error).toBe("template_choice_required");
    const malformed = await schedule(id, { template_revision: 42 });
    expect(malformed.status).toBe(400);
  });

  it("refuses to keep a revision that no longer passes validation (409), pinning nothing", async () => {
    // The post's last send was made with a revision saved under looser rules than
    // today's (inserted directly; a save through the API could never write it). The
    // render path would fall back to the built-in default for it, so the freeze must
    // refuse rather than pin a revision it did not render.
    const stale = {
      id: `stale-${Date.now()}`,
      html: "<div>{{ post.body }}</div>",
      saved_at: 1,
      author: null,
    };
    await insertTemplateRevisionStmt(env.DB, stale).run();
    await saveTemplate(tpl("valid"));
    const id = await makeDraft();
    const first = (await readJson(await schedule(id))).send;
    await cancel(first.id);
    await env.DB.prepare("UPDATE sends SET template_revision = ? WHERE id = ?")
      .bind(stale.id, first.id)
      .run();
    const current = await saveTemplate(tpl("valid-2"));
    expect((await getPost(id)).template.last_made_with.revision).toBe(stale.id);

    const keep = await schedule(id, { template_revision: stale.id });
    expect(keep.status).toBe(409);
    expect((await readJson(keep)).message).toMatch(/no longer passes validation/);
    expect((await getPost(id)).post.status).toBe("draft");
    // The current one still works.
    const use = await schedule(id, { template_revision: current.template.revision });
    expect(use.status).toBe(201);
  });

  it("a restore that brings the same bytes back is not a change: no mark, no report, no choice", async () => {
    const one = await saveTemplate(tpl("same-bytes"));
    const id = await makeDraft();
    const send = (await readJson(await schedule(id))).send;
    expect(send.template_revision).toBe(one.template.revision);
    await saveTemplate(tpl("other-bytes"));
    // Back to the first template, as a new revision with the same html.
    const restored = await readJson(
      await SELF.fetch(`${base}/api/settings/template/revisions/${one.template.revision}/restore`, {
        method: "POST",
        headers: AUTH,
      }),
    );
    expect(restored.template.revision).not.toBe(one.template.revision);
    // The send is on the current template by content, so nothing flags it...
    expect(restored.scheduled_posts_kept.filter((k: any) => k.send_id === send.id)).toEqual([]);
    const post = await getPost(id);
    expect(post.scheduled.template_outdated).toBe(false);
    expect(post.template.changed_since_last_made).toBe(false);
    const sends = await readJson(
      await SELF.fetch(`${base}/sends?status=scheduled`, { headers: AUTH }),
    );
    expect(sends.sends.find((s: any) => s.id === send.id).template_outdated).toBe(false);
    // ...and scheduling it again after a cancel asks no choice.
    await cancel(send.id);
    const again = await schedule(id);
    expect(again.status).toBe(201);
    expect((await readJson(again)).send.template_revision).toBe(restored.template.revision);
  });

  it("when nothing changed since the post was last made, no choice is asked", async () => {
    await saveTemplate(tpl("steady"));
    const id = await makeDraft();
    const first = (await readJson(await schedule(id))).send;
    await cancel(first.id);
    expect((await getPost(id)).template.changed_since_last_made).toBe(false);
    const res = await schedule(id);
    expect(res.status).toBe(201);
    expect((await readJson(res)).send.template_revision).toBe(first.template_revision);
  });
});

describe("a template save reports the scheduled posts it leaves alone", () => {
  it("lists each scheduled send with the revision it keeps, soonest first", async () => {
    const old = await saveTemplate(tpl("kept"));
    const a = await makeDraft("A");
    const b = await makeDraft("B");
    const sendB = (
      await readJson(
        await SELF.fetch(`${base}/posts/${b}/schedule`, {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({ fire_at: future(60 * 60 * 1000) }),
        }),
      )
    ).send;
    const sendA = (await readJson(await schedule(a))).send; // 30 min out: sooner than B
    // A canceled send and a draft are not "scheduled posts kept".
    const c = await makeDraft("C");
    await cancel((await readJson(await schedule(c))).send.id);

    const saved = await saveTemplate(tpl("changed"));
    // (Other tests in this file leave scheduled sends of their own; look at ours.)
    const mine = saved.scheduled_posts_kept.filter((k: any) => [a, b, c].includes(k.post_id));
    expect(mine).toEqual([
      {
        post_id: a,
        send_id: sendA.id,
        fire_at: sendA.fire_at,
        template_revision: old.template.revision,
      },
      {
        post_id: b,
        send_id: sendB.id,
        fire_at: sendB.fire_at,
        template_revision: old.template.revision,
      },
    ]);
    // The sends are untouched: same revision, same bytes.
    expect((await getSend(sendA.id)).send.template_revision).toBe(old.template.revision);
    expect((await getSend(sendA.id)).send.rendered_html).toContain('class="kept"');
    // And every list marks them as made with an older template than the current one.
    const sends = await readJson(
      await SELF.fetch(`${base}/sends?status=scheduled`, { headers: AUTH }),
    );
    const rowA = sends.sends.find((s: any) => s.id === sendA.id);
    expect(rowA.template_revision).toBe(old.template.revision);
    expect(rowA.template_outdated).toBe(true);
    const posts = await readJson(
      await SELF.fetch(`${base}/posts?status=scheduled`, { headers: AUTH }),
    );
    expect(posts.posts.find((p: any) => p.id === a).template_outdated).toBe(true);
    // A save that changes nothing left nothing on an older revision: it says so.
    const same = await saveTemplate(tpl("changed"));
    expect(same.changed).toBe(false);
    expect(same.scheduled_posts_kept).toEqual([]);
    expect(saved.changed).toBe(true);
  });
});

describe("updating a scheduled send to the current template", () => {
  async function scheduledThenChanged() {
    const old = await saveTemplate(tpl("before"));
    const id = await makeDraft("frozen body");
    const send = (await readJson(await schedule(id))).send;
    const current = await saveTemplate(tpl("after"));
    return { id, send, old: old.template, current: current.template };
  }

  it("re-freezes the SAME send: same id and fire time, new revision and render, still scheduled and cancelable", async () => {
    const { id, send, current } = await scheduledThenChanged();
    const res = await SELF.fetch(`${base}/sends/${send.id}/update-template`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const updated = (await readJson(res)).send;
    expect(updated.id).toBe(send.id);
    expect(updated.fire_at).toBe(send.fire_at);
    expect(updated.scheduled_at).toBe(send.scheduled_at);
    expect(updated.status).toBe("scheduled");
    expect(updated.template_revision).toBe(current.revision);
    expect(updated.rendered_html).not.toBe(send.rendered_html);
    expect(updated.rendered_html).toContain('class="after"');
    expect(updated.rendered_html).toContain("frozen body"); // the same content
    // Still the post's one active send, no longer marked, and still cancelable.
    const post = await getPost(id);
    expect(post.scheduled.id).toBe(send.id);
    expect(post.scheduled.template.revision).toBe(current.revision);
    const sends = await readJson(
      await SELF.fetch(`${base}/sends?status=scheduled`, { headers: AUTH }),
    );
    expect(sends.sends.find((s: any) => s.id === send.id).template_outdated).toBe(false);
    await cancel(send.id);
  });

  it("is accepted on a send already on the current template, and picks up the identity", async () => {
    // The identity is not versioned (SPEC §6): a freeze always uses the current one, so
    // an update is how a scheduled send picks up a rename without a cancel.
    await saveTemplate(
      `<div class="named">{{ publication.name }}{{ post.body }}<a href="{{ email.unsubscribeUrl }}">Unsubscribe</a></div>`,
    );
    await updateSettings(env.DB, { publication: { name: "Old Name" } });
    const id = await makeDraft();
    const send = (await readJson(await schedule(id))).send;
    expect(send.rendered_html).toContain("Old Name");
    await updateSettings(env.DB, { publication: { name: "New Name" } });
    // Neither the frozen copy nor the test sees the rename.
    const to = `identity-${id}@example.com`;
    await SELF.fetch(`${base}/posts/${id}/test`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ to }),
    });
    const tested = fakeOutbox().find((m) => m.to === to);
    expect(tested!.html).toContain("Old Name");
    expect(tested!.html).not.toContain("New Name");
    expect((await getPost(id)).scheduled.template_outdated).toBe(false);

    const res = await SELF.fetch(`${base}/sends/${send.id}/update-template`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const updated = (await readJson(res)).send;
    expect(updated.id).toBe(send.id);
    expect(updated.template_revision).toBe(send.template_revision); // same template...
    expect(updated.rendered_html).toContain("New Name"); // ...current identity
  });

  it("what fires after an update is the re-frozen copy", async () => {
    clearFakeOutbox();
    const email = `reader-${Date.now()}@example.com`;
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES (?, ?, 'confirmed', ?, ?, ?, ?)",
    )
      .bind(`sub-${email}`, email, `cfm-${email}`, `uns-${email}`, now, now)
      .run();
    await saveTemplate(tpl("first-look"));
    const id = await makeDraft();
    const send = (await readJson(await schedule(id))).send;
    await saveTemplate(tpl("updated-look"));
    const updated = await SELF.fetch(`${base}/sends/${send.id}/update-template`, {
      method: "POST",
      headers: AUTH,
    });
    expect(updated.status).toBe(200);
    // Bring the fire time into the past and let the sweep deliver it.
    await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
      .bind(now - 1000, send.id)
      .run();
    await sweep(env);
    const delivered = fakeOutbox().find((m) => m.to === email);
    expect(delivered).toBeTruthy();
    expect(delivered!.html).toContain('class="updated-look"');
    expect(delivered!.html).not.toContain('class="first-look"');
    expect((await getSend(send.id)).send.status).toBe("sent");
  });

  it("is refused once the send is sending (409)", async () => {
    const { send } = await scheduledThenChanged();
    await env.DB.prepare("UPDATE sends SET status = 'sending' WHERE id = ?").bind(send.id).run();
    const res = await SELF.fetch(`${base}/sends/${send.id}/update-template`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(409);
    expect((await getSend(send.id)).send.template_revision).toBe(send.template_revision);
  });

  it("is refused inside the minimum lead (409), the same guard as a move", async () => {
    const { send } = await scheduledThenChanged();
    await env.DB.prepare("UPDATE sends SET fire_at = ? WHERE id = ?")
      .bind(Date.now() + SEND_NOW_BUFFER_MS - 60_000, send.id)
      .run();
    const res = await SELF.fetch(`${base}/sends/${send.id}/update-template`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(409);
    expect((await readJson(res)).message).toMatch(/minimum lead/);
    expect((await getSend(send.id)).send.rendered_html).toBe(send.rendered_html);
  });

  it("404s an unknown send and 401s without auth", async () => {
    expect(
      (await SELF.fetch(`${base}/sends/nope/update-template`, { method: "POST", headers: AUTH }))
        .status,
    ).toBe(404);
    expect(
      (await SELF.fetch(`${base}/sends/nope/update-template`, { method: "POST" })).status,
    ).toBe(401);
  });
});

describe("restoring a past revision", () => {
  it("writes a NEW revision equal to the old one; history is never rewritten", async () => {
    const one = await saveTemplate(tpl("one"));
    const two = await saveTemplate(tpl("two"));
    const before = await listTemplateRevisions(env.DB);
    const res = await SELF.fetch(
      `${base}/api/settings/template/revisions/${one.template.revision}/restore`,
      { method: "POST", headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.restored_from).toBe(one.template.revision);
    expect(body.template.revision).not.toBe(one.template.revision);
    expect(body.template.revision).not.toBe(two.template.revision);
    expect(body.settings.emailTemplate).toBe(tpl("one"));
    const after = await listTemplateRevisions(env.DB);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]!.id).toBe(body.template.revision);
    expect((await getTemplateRevision(env.DB, after[0]!.id))!.html).toBe(tpl("one"));
    expect((await getTemplateRevision(env.DB, one.template.revision))!.html).toBe(tpl("one"));
    expect((await getTemplateRevision(env.DB, two.template.revision))!.html).toBe(tpl("two"));
    // Both earlier revisions are still there, unchanged.
    expect(after.map((r) => r.id)).toEqual(
      expect.arrayContaining([one.template.revision, two.template.revision]),
    );
    expect((await getTemplate()).revision).toBe(body.template.revision);
  });

  it("reports the scheduled sends it leaves on the revision they had", async () => {
    const one = await saveTemplate(tpl("r-one"));
    const two = await saveTemplate(tpl("r-two"));
    const id = await makeDraft();
    const send = (await readJson(await schedule(id))).send;
    expect(send.template_revision).toBe(two.template.revision);
    const body = await readJson(
      await SELF.fetch(`${base}/api/settings/template/revisions/${one.template.revision}/restore`, {
        method: "POST",
        headers: AUTH,
      }),
    );
    expect(body.scheduled_posts_kept.filter((k: any) => k.post_id === id)).toEqual([
      {
        post_id: id,
        send_id: send.id,
        fire_at: send.fire_at,
        template_revision: two.template.revision,
      },
    ]);
  });

  it("refuses to restore a revision that no longer passes validation (400), leaving the current one", async () => {
    // A revision saved under looser rules than today's: inserted directly, since a save
    // through the API could never have written it.
    const stale = {
      id: "stale-rev",
      html: "<div>{{ post.body }}</div>",
      saved_at: 1,
      author: null,
    };
    await insertTemplateRevisionStmt(env.DB, stale).run();
    const before = await getTemplate();
    const res = await SELF.fetch(`${base}/api/settings/template/revisions/${stale.id}/restore`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).message).toMatch(/unsubscribe/i);
    expect((await getTemplate()).revision).toBe(before.revision);
  });

  it("404s an unknown revision", async () => {
    const res = await SELF.fetch(`${base}/api/settings/template/revisions/nope/restore`, {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });
});
