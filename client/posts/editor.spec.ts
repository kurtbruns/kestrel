import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAILY_WRITES_SEND_RECIPIENTS,
  dailyWritesSendWarning,
  type SendSummary,
} from "../../shared/sends";
import type { SettingsResponse } from "../../shared/settings";
import { slugify } from "../../shared/slug";
import type { ViewHandle } from "../lifecycle";
import { readSendsNow } from "../send_state";
import { appState } from "../state";
import { feedReads, sendServer } from "../test/send_server";
import {
  $,
  type FakeApi,
  type FakeRequest,
  type FakeRoute,
  fakeApi,
  jsonResponse,
  mount,
  mounted,
  resetShell,
  restoreHidden,
  sendSummary,
  setHidden,
  settingsResponse,
  typeInto,
  unmount,
} from "../test/support";
import { fmt, toLocalInput } from "../ui/format";
import { renderEditor } from "./editor";

type Draft = {
  post: Record<string, unknown>;
  /** The subject's slug, when another post holds it and so the address didn't follow. */
  subject_slug_held: string | null;
  markdown: string;
  author: string | null;
  scheduled?: { id: string; fire_at: number; remade_at: number | null } | null;
};

const draft = (over: Record<string, unknown> = {}): Draft => ({
  post: {
    id: "p1",
    subject: "Owls",
    slug: "owls",
    slug_auto: true,
    unlisted_token: "t0k3n",
    unlisted_url: "https://newsletter.example.com/email/t0k3n",
    published_at: null,
    status: "draft",
    email_only: false,
    current_revision: "r1",
    updated_at: "2026-09-20T10:00:00Z",
    ...over,
  },
  markdown: "# Owls\n\nHoot.",
  author: "a@b.c",
  subject_slug_held: null,
});

/**
 * A draft on a stateful fake server: GET answers the current state, PUT applies the save
 * and advances the revision. Consistent the way the real server is, which matters because
 * the editor's freshness poll compares what GET says against what its own saves produced.
 */
function draftServer(initial = draft()) {
  let state = initial;
  let n = 1;
  const server = {
    get: () => state,
    /** Apply a save, unless `intercept` answers instead (a 409, or a promise to answer later). */
    put(
      req: FakeRequest,
      intercept?: (req: FakeRequest) => Response | Promise<unknown> | undefined,
    ) {
      return intercept?.(req) ?? server.apply(req);
    },
    apply(req: FakeRequest) {
      const body = req.json() as Record<string, unknown>;
      n += 1;
      const post: Record<string, unknown> = { ...state.post, ...body, current_revision: `r${n}` };
      return server.settle(post, body);
    },
    /** A change to the post's settings (`PUT …/settings`): no revision, as the server writes
     *  none for one. */
    listing(req: FakeRequest) {
      const body = req.json() as Record<string, unknown>;
      const answer = server.settle({ ...state.post, ...body }, body);
      return answer instanceof Response ? answer : { ...answer, changed: true };
    },
    /** The server's slug rules (SPEC §4): a slug sent by hand is refused when malformed or
     *  another post's; a following slug takes the subject's unless another post holds it,
     *  and then takes the first free number after it and says which it couldn't take. */
    settle(post: Record<string, unknown>, body: Record<string, unknown>) {
      if (typeof body.slug === "string") {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) {
          return jsonResponse(
            { error: "slug_invalid", message: "Use lowercase letters and numbers.", field: "slug" },
            400,
          );
        }
        if (server.taken.has(body.slug)) {
          return jsonResponse(
            {
              error: "slug_taken",
              message: "Another post already has this address.",
              field: "slug",
            },
            409,
          );
        }
        post.slug_auto = false;
      }
      let subject_slug_held: string | null = null;
      if (post.slug_auto) {
        const want = slugify(String(post.subject)) || "post";
        if (server.taken.has(want)) {
          subject_slug_held = want;
          let n = 2;
          while (server.taken.has(`${want}-${n}`)) {
            n += 1;
          }
          post.slug = `${want}-${n}`;
        } else {
          post.slug = want;
        }
      }
      state = { ...state, post, subject_slug_held };
      return { post: state.post, subject_slug_held };
    },
    /** Slugs other posts hold. */
    taken: new Set<string>(),
    /** Another writer saved: the server moves on to a new revision. */
    elsewhere(author: string): string {
      n += 1;
      state = { ...state, post: { ...state.post, current_revision: `r${n}` }, author };
      return `r${n}`;
    },
    /** The send that soft-locks the post, or null once canceled. */
    scheduled(send: Draft["scheduled"]) {
      state = { ...state, scheduled: send };
    },
  };
  return server;
}

/** The post's scheduled send, as the send routes store it. */
const sendRow = (over: Partial<SendSummary> = {}): SendSummary =>
  sendSummary({ id: "s1", post_id: "p1", subject: "Owls", recipient_count: 40, ...over });

/**
 * A scheduled post and its send on one fake server, so the post's read and the send
 * routes (the send, the feed) always agree, and a change made elsewhere changes both, the
 * way the real server does.
 */
function scheduledPost(fireAt = Date.now() + 3_600_000, remadeAt: number | null = null) {
  const post = draftServer(draft({ status: "scheduled" }));
  const sends = sendServer([sendRow({ fire_at: fireAt, remade_at: remadeAt })]);
  let send = { id: "s1", fire_at: fireAt, remade_at: remadeAt };
  post.scheduled(send);
  let sending: { id: string } | null = null;
  const postRoute: FakeRoute = { path: "/api/posts/p1", reply: () => ({ ...post.get(), sending }) };
  return {
    server: post,
    sends,
    postRoute,
    routes: [
      postRoute,
      // A scheduled post opens on Preview, its frozen email.
      { path: "/api/posts/p1/preview", reply: () => new Response("<p>Owls</p>") },
      ...sends.routes,
    ],
    /** The sweep starts it. */
    start() {
      sending = { id: "s1" };
      post.scheduled(null);
      sends.edit("s1", { status: "sending", started_at: Date.now(), c_pending: 40 });
    },
    /** Canceled, here or elsewhere: the post is a draft again. */
    cancel() {
      post.apply({ json: () => ({ status: "draft" }) } as FakeRequest);
      post.scheduled(null);
      sends.edit("s1", { status: "canceled", completed_at: Date.now() });
    },
    /** Moved elsewhere. */
    move(at: number) {
      send = { ...send, fire_at: at };
      post.scheduled(send);
      sends.edit("s1", { fire_at: at });
    },
    /** Re-made by a template or identity change. */
    remake(at: number) {
      send = { ...send, remade_at: at };
      post.scheduled(send);
      sends.edit("s1", { remade_at: at });
    },
  };
}

/** The editor offers every member; a missing one is a test failure, not a branch. */
function unwrapHandle(h: ViewHandle | null): Required<ViewHandle> {
  if (!h?.dirty || !h.beforeLeave || !h.manualSave) {
    throw new Error("the editor offered no handle");
  }
  return { dirty: h.dirty, beforeLeave: h.beforeLeave, manualSave: h.manualSave };
}

describe("editor view", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
    location.hash = "#/edit/p1";
  });
  afterEach(() => {
    fake?.restore();
    restoreHidden();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // The editor mounted the way the router mounts it; `handle()` is what the router sees.
  async function open(routes: FakeRoute[]) {
    fake = fakeApi(routes);
    await mount((r, s) => renderEditor("p1", r, s));
    await vi.advanceTimersByTimeAsync(0);
  }
  const handle = () => unwrapHandle(mounted());
  /** The draft's saves: each writes a revision (a listing change, its own route, writes none). */
  const puts = () =>
    fake.calls.filter((c) => c.method === "PUT" && c.url.pathname === "/api/posts/p1");
  const body = () => $<HTMLTextAreaElement>("#f-markdown");

  it("mounts a draft into its fields and reads as saved", async () => {
    await open([{ path: "/api/posts/p1", reply: () => draft() }]);
    expect($<HTMLInputElement>("#f-subject").value).toBe("Owls");
    expect(body().value).toBe("# Owls\n\nHoot.");
    // In the archive, the default: the head marks nothing, and a draft names no destination.
    expect($("#headEmailOnly").hidden).toBe(true);
    expect(document.querySelector("#schedDest")).toBeNull();
    expect($("#saveStatus").textContent).toBe("Saved");
    expect(handle().dirty()).toBe(false);
  });

  it("marks an edit dirty, then autosaves it after the idle pause with the base revision", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
    ]);
    typeInto(body(), "# Owls\n\nHoot hoot.");
    expect($("#saveStatus").textContent).toBe("Unsaved changes");
    expect(handle().dirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(puts()[0]?.json()).toMatchObject({
      markdown: "# Owls\n\nHoot hoot.",
      base_revision: "r1",
    });
    expect($("#saveStatus").textContent).toBe("Saved");
    expect(fake.unhandled).toEqual([]);
  });

  it("saves at the hard cap while the typing never pauses", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
    ]);
    for (let ms = 0; ms < 30000; ms += 1000) {
      typeInto(body(), `${body().value}.`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(puts()).toHaveLength(1);
  });

  it("keeps an edit typed during an in-flight save dirty, and sends it with the next save", async () => {
    const server = draftServer();
    let release: () => void = () => {};
    let held = false;
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: (req) =>
          server.put(req, (r) => {
            if (held) {
              return undefined;
            }
            held = true; // the first save is held open until the spec releases it
            return new Promise((resolve) => {
              release = () => resolve(server.apply(r));
            });
          }),
      },
    ]);
    typeInto(body(), "one");
    await vi.advanceTimersByTimeAsync(5000); // the first save is in flight, holding "one"
    expect($("#saveStatus").textContent).toBe("Saving…");
    typeInto(body(), "one two"); // typed while it is in flight
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#saveStatus").textContent).toBe("Unsaved changes"); // "two" was not in that save
    await vi.advanceTimersByTimeAsync(5000);
    expect(puts().map((p) => (p.json() as { markdown: string }).markdown)).toEqual([
      "one",
      "one two",
    ]);
    expect($("#saveStatus").textContent).toBe("Saved");
  });

  it("shows the out-of-date banner on a stale save, pauses autosave, and keep-editing adopts the newer base", async () => {
    const server = draftServer();
    let theirs: string | null = null;
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: (req) =>
          server.put(req, (r) => {
            // Our first save loses a race: Claude saved first, so the server refuses ours,
            // and keeps refusing until we save against that revision.
            if (theirs === null) {
              theirs = server.elsewhere("service");
            }
            if ((r.json() as { base_revision: string }).base_revision === theirs) {
              return undefined;
            }
            return jsonResponse(
              {
                error: "stale_revision",
                message: "changed",
                current_revision: theirs,
                author: "service",
              },
              409,
            );
          }),
      },
    ]);
    typeInto(body(), "mine");
    await vi.advanceTimersByTimeAsync(5000);
    const banner = $("#freshnessBanner");
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/changed elsewhere/);
    expect(banner.textContent).toMatch(/Claude/); // "service" reads as Claude
    expect(handle().beforeLeave()).toBe("confirm"); // a leave would clobber: the router must ask
    typeInto(body(), "mine still");
    await vi.advanceTimersByTimeAsync(30000);
    expect(puts()).toHaveLength(1); // paused while the banner is up
    $("#freshKeep").click();
    expect(banner.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(puts()).toHaveLength(2);
    expect(puts()[1]?.json()).toMatchObject({ base_revision: theirs, markdown: "mine still" });
    expect($("#saveStatus").textContent).toBe("Saved");
  });

  it("warns when the freshness poll finds a newer revision, and locks when the post left draft", async () => {
    const server = draftServer();
    await open([{ path: "/api/posts/p1", reply: server.get }]);
    server.elsewhere("x@y.z");
    await vi.advanceTimersByTimeAsync(10000);
    const banner = $("#freshnessBanner");
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/x@y\.z/);
    $("#freshKeep").click();
    server.apply({ json: () => ({ status: "scheduled" }) } as FakeRequest);
    await vi.advanceTimersByTimeAsync(10000);
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/scheduled elsewhere/);
    expect(document.querySelector("#freshKeep")).toBeNull(); // nothing to keep editing
  });

  it("makes Save draft unavailable while the out-of-date banner is up, pointing at it instead of pretending to save", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
    ]);
    // happy-dom has no layout, so scrollIntoView is only observable as a call.
    const intoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    server.elsewhere("service");
    await vi.advanceTimersByTimeAsync(10000); // the freshness poll finds Claude's save
    const banner = $("#freshnessBanner");
    expect(banner.hidden).toBe(false);
    // The copy names the control that works, and says saving waits on it.
    expect(banner.textContent).toMatch(/Saving is paused until you choose/);
    expect(banner.textContent).toMatch(/Keep editing to keep yours/);
    typeInto(body(), "mine");
    const save = $<HTMLButtonElement>("#saveBtn");
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.title).toMatch(/Reload or Keep editing/);
    // A click, or the save shortcut, saves nothing and never shows Saving…; it brings the
    // banner into view instead.
    save.click();
    handle().manualSave?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(0);
    expect(save.textContent).toBe("Save draft");
    expect($("#saveStatus").textContent).toBe("Unsaved changes");
    expect(intoView).toHaveBeenCalledTimes(2);
    expect(intoView.mock.contexts[0]).toBe(banner);
    // Keep editing is the decision: the button is live again, and saves over the newer base.
    $("#freshKeep").click();
    expect(save.hasAttribute("aria-disabled")).toBe(false);
    expect(save.hasAttribute("title")).toBe(false);
    save.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.json()).toMatchObject({ markdown: "mine", base_revision: "r2" });
    expect(fake.unhandled).toEqual([]);
  });

  it("flushes a dirty draft on navigation and marks it saved as sent", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
    ]);
    typeInto(body(), "leaving");
    expect(handle().beforeLeave()).toBe("leave"); // saved in the background, no prompt
    expect(handle().dirty()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()[0]?.json()).toMatchObject({ markdown: "leaving", base_revision: "r1" });
  });

  it("cancels a pending autosave when the app tears the editor down", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
    ]);
    typeInto(body(), "half-typed");
    expect($("#saveStatus").textContent).toBe("Unsaved changes"); // an autosave is armed
    // What navigating away and the re-auth wall do: the armed save must not fire after it.
    unmount();
    expect(mounted()).toBeNull();
    await vi.advanceTimersByTimeAsync(30000);
    expect(puts()).toEqual([]);
  });

  it("redirects a sent post to its record and a post in flight to the live watch, in place of its history entry", async () => {
    // happy-dom's replace() pushes an entry as assign() does, so the spec asserts the call.
    const replace = vi.spyOn(location, "replace");
    await open([
      {
        path: "/api/posts/p1",
        reply: () => ({ ...draft({ status: "sent" }), sent: { id: "x9" } }),
      },
    ]);
    expect(location.hash).toBe("#/sent/x9");
    expect(replace).toHaveBeenLastCalledWith("#/sent/x9"); // so Back skips the editor URL
    location.hash = "#/edit/p1";
    fake.restore();
    await open([{ path: "/api/posts/p1", reply: () => ({ ...draft(), sending: { id: "x8" } }) }]);
    expect(location.hash).toBe("#/sent/x8");
    expect(replace).toHaveBeenLastCalledWith("#/sent/x8");
    expect(document.querySelector("#f-markdown")).toBeNull(); // never mounted
  });

  const reads = () =>
    fake.calls.filter((c) => c.method === "GET" && c.url.pathname === "/api/posts/p1");

  it("hands a scheduled post off to the live watch within a feed read of its send starting, with a toast, in place of its history entry", async () => {
    const linked = scheduledPost(Date.now() + 5_000);
    await open(linked.routes);
    const replace = vi.spyOn(location, "replace");
    await vi.advanceTimersByTimeAsync(7_000); // past the fire time: the layer reads closely
    expect(location.hash).toBe("#/edit/p1");
    linked.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(location.hash).toBe("#/sent/s1");
    expect(replace).toHaveBeenCalledWith("#/sent/s1");
    expect($("#toasts").textContent).toMatch(/switched to its live watch/);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("follows its send through the layer, reading at once when a hidden tab is shown again", async () => {
    const linked = scheduledPost();
    // The clock stands still until the spec advances it, so this is the cursor the send's
    // read is handed.
    const cursor = linked.sends.cursor();
    await open(linked.routes);
    expect(feedReads(fake)).toHaveLength(1); // the layer's first read, from the send's cursor
    expect(feedReads(fake)[0]?.url.searchParams.get("since")).toBe(cursor);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(120_000); // a hidden tab reads nothing
    expect(feedReads(fake)).toHaveLength(1);
    linked.start();
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(feedReads(fake)).toHaveLength(2);
    expect(location.hash).toBe("#/sent/s1");
    expect(reads()).toHaveLength(1); // no poll of the post of its own
  });

  it("reads a draft's freshness at once when a hidden tab is shown again", async () => {
    const server = draftServer();
    await open([{ path: "/api/posts/p1", reply: server.get }]);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(reads()).toHaveLength(1);
    server.elsewhere("service");
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toHaveLength(2);
    expect($("#freshnessBanner").hidden).toBe(false);
  });

  it("stops reading on a shown tab once the editor is torn down", async () => {
    await open([{ path: "/api/posts/p1", reply: draftServer().get }]);
    unmount();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toHaveLength(1);
  });

  it("counts the banner down on the clock, then says in the same line that the send is being prepared", async () => {
    const linked = scheduledPost(Date.now() + 65_000);
    await open(linked.routes);
    const when = () => $("#schedWhen").textContent;
    expect(when()).toMatch(/^Scheduled for .+ · Sends in 1m 05s$/);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(when()).toMatch(/Sends in 1m 04s/);
    expect($<HTMLElement>("#schedControls").hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(64_000);
    expect(when()).toMatch(/^Scheduled for .+ · Preparing to send…$/);
    expect($<HTMLElement>("#schedControls").hidden).toBe(false);
    expect($<HTMLButtonElement>("#rescheduleSchedule").disabled).toBe(true);
    expect($<HTMLButtonElement>("#cancelSchedule").disabled).toBe(true);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("says a send past the server's missed tolerance is late, in the danger tone", async () => {
    const linked = scheduledPost(Date.now() - 7 * 60_000);
    await open(linked.routes);
    expect($("#schedWhen").textContent).toMatch(
      /^Scheduled for .+ · Missed its fire time · 7 min late$/,
    );
    expect($("#schedWhen .countdown-missed")).toBeTruthy();
    expect($<HTMLElement>("#schedControls").hidden).toBe(true);
  });

  // DESIGN §4: while no provider is connected, a scheduled send's window is real, but the
  // send is held when it fires, and the banner says so beside the countdown it keeps.
  it("says a scheduled send will be held while no provider is connected, and keeps the countdown", async () => {
    appState.appConfig = settingsResponse({ deployment: { provider: "none" } });
    const linked = scheduledPost(Date.now() + 65_000);
    await open(linked.routes);
    expect($("#schedWhen").textContent).toMatch(/Sends in 1m 05s/);
    expect($(".banner-scheduled .sched-note-held .sched-note-msg").textContent).toBe(
      "Will be held: no email provider is connected.",
    );
    expect(document.querySelector(".editor-not-connected")).toBeNull(); // the draft's line
    unmount();
    fake.restore();
    appState.appConfig = settingsResponse({ deployment: { provider: "ses" } });
    await open(scheduledPost(Date.now() + 65_000).routes);
    expect(document.querySelector(".sched-note-held")).toBeNull();
  });

  it("notes above a draft's actions that it can be written and previewed, not sent, while no provider is connected", async () => {
    appState.appConfig = settingsResponse({ deployment: { provider: "none" } });
    await open([{ path: "/api/posts/p1", reply: () => draft() }]);
    const note = $(".editor-not-connected");
    expect(note.classList.contains("health")).toBe(true);
    expect(note.classList.contains("amber")).toBe(true);
    expect(note.textContent).toBe(
      "⚠️No email provider connected: you can write and preview, not send. Connect Amazon SES.",
    );
    expect($<HTMLAnchorElement>("a", note).getAttribute("href")).toBe("#/docs/ses");
    expect(note.nextElementSibling?.classList.contains("actions-bar")).toBe(true);
    for (const provider of ["ses", "fake"] as const) {
      unmount();
      fake.restore();
      appState.appConfig = settingsResponse({ deployment: { provider } });
      await open([{ path: "/api/posts/p1", reply: () => draft() }]);
      expect(document.querySelector(".editor-not-connected"), provider).toBeNull();
    }
  });

  it("shows a move, a re-make, and a cancel made elsewhere, in place", async () => {
    const linked = scheduledPost(Date.now() + 3_600_000);
    await open(linked.routes);
    expect($("#schedWhen").textContent).toMatch(/Sends in 1h/);
    expect($("#schedRemade").hidden).toBe(true);

    linked.move(Date.now() + 2 * 3_600_000); // Claude moves it
    await vi.advanceTimersByTimeAsync(60_000); // within one idle read
    expect($("#schedWhen").textContent).toMatch(/Sends in 1h 59m/);

    linked.remake(Date.now());
    await vi.advanceTimersByTimeAsync(60_000);
    expect($("#schedRemade").hidden).toBe(false);
    expect($("#schedRemadeMsg").textContent).toBe(
      "The template or publication details changed this email’s look after your last test. Its content and send time are the same. Send a new test to check what will go out.",
    );

    linked.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect($("#toasts").textContent).toMatch(/canceled elsewhere/);
    expect(document.querySelector(".banner-scheduled")).toBeNull();
    expect(body().readOnly).toBe(false);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("says on the banner that no test has been sent, until one is (SPEC §8)", async () => {
    const linked = scheduledPost();
    await open(linked.routes);
    expect($("#schedUntested").hidden).toBe(false);
    expect($("#schedUntestedMsg").textContent).toBe(
      "No test of this email has been sent yet. Send yourself a test to check what will go out.",
    );
    expect($("#schedRemade").hidden).toBe(true);

    linked.sends.edit("s1", { tested_at: Date.now() }); // a test lands, here or from Claude
    await vi.advanceTimersByTimeAsync(60_000);
    expect($("#schedUntested").hidden).toBe(true);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("says on the banner when the server warns the send may spend D1's daily writes (SPEC §8)", async () => {
    const linked = scheduledPost();
    const message = dailyWritesSendWarning(6_000);
    linked.sends.edit(
      "s1",
      {},
      {
        conditions: [
          {
            kind: "daily_writes",
            severity: "warn",
            since: Date.now(),
            message,
            action: null,
            recipients: 6_000,
          },
        ],
      },
    );
    await open(linked.routes);
    expect($("#schedDailyWrites").hidden).toBe(false);
    expect($("#schedDailyWritesMsg").textContent).toBe(message);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("hands off at once when the send read finds the send already started", async () => {
    const linked = scheduledPost();
    linked.sends.edit("s1", { status: "sending", started_at: Date.now() }); // the post read lags
    await open(linked.routes);
    expect(location.hash).toBe("#/sent/s1");
    expect(document.querySelector(".banner-scheduled")).toBeNull();
  });

  it("reopens as a draft when the send read finds the send already canceled", async () => {
    const linked = scheduledPost();
    let postReads = 0;
    await open([
      {
        path: "/api/posts/p1",
        reply: (req) => {
          // The first read still says scheduled; the send was canceled right after it.
          if (++postReads === 1) {
            linked.cancel();
            return {
              ...draft({ status: "scheduled" }),
              scheduled: { id: "s1", fire_at: Date.now() + 3_600_000, remade_at: null },
              sending: null,
            };
          }
          return linked.postRoute.reply(req);
        },
      },
      ...linked.routes.slice(1),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".banner-scheduled")).toBeNull();
    expect(body().readOnly).toBe(false);
  });

  it("goes to Drafts when the send is gone by the time the editor reads it", async () => {
    const linked = scheduledPost();
    linked.sends.remove("s1");
    await open(linked.routes);
    expect(location.hash).toBe("#/drafts");
    expect($("#toasts").textContent).toMatch(/deleted elsewhere/);
  });

  it("opens with the post's own banner when the send read fails, and follows once it answers", async () => {
    const linked = scheduledPost();
    let failures = 1;
    const sendRead = linked.sends.routes.find((r) => r.path instanceof RegExp);
    await open([
      // Tried first: the send's read fails once, then the fake send server answers it.
      {
        path: "/api/sends/s1",
        reply: (req) =>
          failures-- > 0 ? jsonResponse({ error: "down" }, 503) : sendRead?.reply(req),
      },
      ...linked.routes,
    ]);
    expect(body().readOnly).toBe(true);
    expect($("#schedWhen").textContent).toMatch(/Sends in 1h/);
    expect(feedReads(fake)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000); // the send read is tried again
    expect(feedReads(fake)).toHaveLength(1); // and the editor follows from it
    linked.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(body().readOnly).toBe(false);
  });

  it("opens Reschedule at the time a move made elsewhere set", async () => {
    const linked = scheduledPost(Date.now() + 3_600_000);
    await open(linked.routes);
    const moved = Date.now() + 2 * 3_600_000;
    linked.move(moved);
    await vi.advanceTimersByTimeAsync(60_000);
    $("#rescheduleSchedule").click();
    expect($<HTMLInputElement>("#rsWhen").value).toBe(toLocalInput(new Date(moved)));
  });

  it("goes to Drafts, saying so once, when Reschedule finds the post deleted elsewhere", async () => {
    const linked = scheduledPost(Date.now() + 3_600_000);
    await open([
      ...linked.routes,
      {
        method: "POST",
        path: "/api/sends/s1/reschedule",
        reply: () => {
          linked.sends.remove("s1"); // deleted with its post before the follow noticed
          return jsonResponse({ error: "not_found", message: "send" }, 404);
        },
      },
    ]);
    $("#rescheduleSchedule").click();
    $<HTMLInputElement>("#rsWhen").value = toLocalInput(new Date(Date.now() + 2 * 3_600_000));
    $("#rsGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".modal")).toBeNull();
    expect(location.hash).toBe("#/drafts"); // the follow, read at once, found the send gone
    expect($("#toasts").textContent).toBe("This post was deleted elsewhere.");
  });

  it("refuses a reschedule inside the minimum lead under its picker, before asking the server", async () => {
    const linked = scheduledPost();
    await open(linked.routes);
    $("#rescheduleSchedule").click();
    const when = $<HTMLInputElement>("#rsWhen");
    when.value = toLocalInput(new Date(Date.now() + 60_000));
    $("#rsGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.some((c) => c.url.pathname === "/api/sends/s1/reschedule")).toBe(false);
    expect(when.classList.contains("is-invalid")).toBe(true);
    // No Send now in this dialog, so the reason says only why.
    expect($(".modal .field-error").textContent).toBe(
      "!Pick a time at least 5 minutes from now, so there’s time to cancel.",
    );
  });

  it("shows the server's own minimum-lead refusal of a reschedule under its picker as it stands", async () => {
    const linked = scheduledPost();
    await open([
      {
        method: "POST",
        path: "/api/sends/s1/reschedule",
        // The server's lead, not the page's default five minutes.
        reply: () =>
          jsonResponse(
            {
              error: "fire_at_too_soon",
              message: "Pick a time at least 90 seconds from now, so there’s time to cancel.",
              field: "fire_at",
            },
            400,
          ),
      },
      ...linked.routes,
    ]);
    $("#rescheduleSchedule").click();
    const when = $<HTMLInputElement>("#rsWhen");
    when.value = toLocalInput(new Date(Date.now() + 86_400_000));
    $("#rsGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(when.classList.contains("is-invalid")).toBe(true);
    expect($(".modal .field-error").textContent).toBe(
      "!Pick a time at least 90 seconds from now, so there’s time to cancel.",
    );
  });

  it("says a send turned missed while the editor is open", async () => {
    await open(scheduledPost(Date.now() + 5_000).routes);
    expect($("#schedWhen").textContent).toMatch(/Sends in/);
    await vi.advanceTimersByTimeAsync(6 * 60_000); // past the fire time and the tolerance
    expect($("#schedWhen .countdown-missed").textContent).toMatch(
      /^Missed its fire time · \d+ min late$/,
    );
    expect(fake.unhandled).toHaveLength(0);
  });

  it("goes to Drafts when its post is deleted elsewhere", async () => {
    const linked = scheduledPost();
    await open(linked.routes);
    linked.sends.remove("s1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(location.hash).toBe("#/drafts");
    expect($("#toasts").textContent).toMatch(/deleted elsewhere/);
  });

  // A post deleted elsewhere: what a read or write of it answers from then on.
  const postGone = () => jsonResponse({ error: "not_found", message: "post not found" }, 404);

  it("goes to Drafts when the freshness poll finds the draft deleted elsewhere (SPEC §4)", async () => {
    let deleted = false;
    await open([{ path: "/api/posts/p1", reply: () => (deleted ? postGone() : draft()) }]);
    deleted = true;
    await vi.advanceTimersByTimeAsync(10000);
    expect(location.hash).toBe("#/drafts");
    expect($("#toasts").textContent).toBe("This post was deleted elsewhere.");
    await vi.advanceTimersByTimeAsync(30000);
    expect(reads()).toHaveLength(2); // it stops reading a post that is gone
  });

  it("goes to Drafts when a save finds the draft deleted elsewhere, unsaved edits and all (SPEC §4)", async () => {
    await open([
      { path: "/api/posts/p1", reply: () => draft() },
      { method: "PUT", path: "/api/posts/p1", reply: postGone },
    ]);
    typeInto(body(), "mine");
    await vi.advanceTimersByTimeAsync(5000);
    expect(puts()).toHaveLength(1);
    expect(location.hash).toBe("#/drafts");
    expect($("#toasts").textContent).toBe("This post was deleted elsewhere."); // not a save error
    expect(handle().beforeLeave()).toBe("leave"); // no prompt, and no save to a post that is gone
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
  });

  it("says a leave's save found the draft deleted elsewhere, without moving the reader", async () => {
    await open([
      { path: "/api/posts/p1", reply: () => draft() },
      { method: "PUT", path: "/api/posts/p1", reply: postGone },
    ]);
    typeInto(body(), "leaving");
    expect(handle().beforeLeave()).toBe("leave");
    location.hash = "#/sent"; // where the reader went
    unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    expect($("#toasts").textContent).toBe(
      "This post was deleted elsewhere, so your last edits weren’t saved.",
    );
    expect(location.hash).toBe("#/sent");
  });

  it("shows the error with a retry that mounts the draft", async () => {
    let failures = 1;
    await open([
      {
        path: "/api/posts/p1",
        reply: () => (failures-- > 0 ? jsonResponse({ error: "down" }, 500) : draft()),
      },
    ]);
    expect($("#app .error").textContent).toMatch(/went wrong on the server/);
    $("[data-retry]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($<HTMLInputElement>("#f-subject").value).toBe("Owls");
  });

  it("does not save on the Enter that ends an IME composition", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
    ]);
    const subject = $<HTMLInputElement>("#f-subject");
    typeInto(subject, "フクロウ");
    subject.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    subject.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(0);
  });

  it("saves on Enter in the subject", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
    ]);
    const subject = $<HTMLInputElement>("#f-subject");
    typeInto(subject, "Barn owls");
    subject.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    // The address is a publishing setting, never sent with a save.
    expect(puts()[0]?.json()).not.toHaveProperty("slug");
    expect($("#saveStatus").textContent).toBe("Saved");
  });

  it("opens a new post with an empty subject under an Untitled placeholder, its address following the subject once saved", async () => {
    // What the server makes of a new post: no subject, and its stand-in slug.
    const server = draftServer(draft({ subject: "", slug: "post-3" }));
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
    ]);
    const subject = $<HTMLInputElement>("#f-subject");
    expect(subject.value).toBe("");
    expect(subject.placeholder).toBe("Untitled");
    subject.focus();
    typeInto(subject, "Welcome to The Compiler");
    body().focus();
    await vi.advanceTimersByTimeAsync(0);
    $("#settingsBtn").click();
    expect($<HTMLInputElement>("#psSlug").value).toBe("welcome-to-the-compiler");
    expect($("#psNote").textContent).toBe("Follows the subject until you type your own.");
  });

  it("formats the selection from the toolbar and by shortcut, and marks the draft dirty", async () => {
    await open([{ path: "/api/posts/p1", reply: () => draft() }]);
    const ta = body();
    ta.setSelectionRange(2, 6); // "Owls"
    $(".tb[data-fmt='bold']").click();
    expect(ta.value).toBe("# **Owls**\n\nHoot.");
    expect($("#saveStatus").textContent).toBe("Unsaved changes");
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(ta.value).toMatch(/\[link text\]\(https:\/\/\)$/);
    $(".tb[data-fmt='quote']").click();
    expect(ta.value.split("\n").at(-1)).toMatch(/^> /);
  });

  it("opens the preview: a silent save, then the rendered email into the frame", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
      {
        path: "/api/posts/p1/preview",
        reply: () => new Response("<p>rendered</p>", { headers: { "content-type": "text/html" } }),
      },
    ]);
    typeInto(body(), "changed");
    $(".ctab[data-tab='preview']").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1); // the preview is of what is saved
    const frame = $<HTMLIFrameElement>("#previewFrame");
    expect(frame.hidden).toBe(false);
    expect(frame.srcdoc).toBe("<p>rendered</p>");
    // A link may open a new tab (and its page escape the sandbox), but the email never runs
    // script or submits a form.
    const sandbox = frame.getAttribute("sandbox")?.split(" ");
    expect(sandbox).toEqual([
      "allow-same-origin",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
    ]);
    expect(body().hidden).toBe(true);
  });

  it("says why the preview can't be shown in the server's words", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        path: "/api/posts/p1/preview",
        reply: () =>
          jsonResponse(
            {
              error: "bad_request",
              message: "This post has no content yet. Write something, then try again.",
            },
            400,
          ),
      },
    ]);
    $(".ctab[data-tab='preview']").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#toasts").textContent).toBe(
      "This post has no content yet. Write something, then try again.",
    );
    expect(fake.unhandled).toEqual([]);
  });

  it("goes to Drafts, saying so once, when the preview finds its post deleted elsewhere", async () => {
    let deleted = false;
    await open([
      { path: "/api/posts/p1", reply: () => (deleted ? postGone() : draft()) },
      { path: "/api/posts/p1/preview", reply: postGone },
    ]);
    deleted = true;
    $(".ctab[data-tab='preview']").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(location.hash).toBe("#/drafts");
    expect($("#toasts").textContent).toBe("This post was deleted elsewhere.");
    // The poll finds it gone too, at 10s, after that toast has faded: nothing more is said.
    await vi.advanceTimersByTimeAsync(10000);
    expect($("#toasts").textContent).toBe("");
    expect(fake.unhandled).toEqual([]);
  });

  describe("the preview's link to the post's own public page", () => {
    const ARCHIVE = "https://newsletter.example.com/archive";
    const webUrl = () => `${location.origin}${location.pathname}#/web/post/p1`;
    beforeEach(() => {
      appState.appConfig = {
        deployment: {
          appOrigin: "https://newsletter.example.com",
          archiveOrigin: "https://newsletter.example.com",
          archiveBasePath: "/archive",
        },
      } as unknown as SettingsResponse;
    });
    afterEach(() => {
      appState.appConfig = null;
    });
    /** The post's unlisted link, the "view in browser" its emails carry (SPEC §5). */
    const UNLISTED = "https://newsletter.example.com/email/t0k3n";
    /** The preview frame loaded with `markup`, as the browser would load its srcdoc
     *  (happy-dom loads none), and its links. */
    function loadPreview(markup: string): HTMLAnchorElement[] {
      const frame = $<HTMLIFrameElement>("#previewFrame");
      const doc = frame.contentDocument!;
      doc.open();
      doc.write(markup);
      doc.close();
      frame.dispatchEvent(new Event("load"));
      return [...doc.querySelectorAll("a")];
    }

    it("opens a draft's web version from its unlisted link, whatever its slug, and leaves every other link alone", async () => {
      const server = draftServer();
      await open([
        { path: "/api/posts/p1", reply: server.get },
        { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
        { path: "/api/posts/p1/preview", reply: () => new Response("<p>rendered</p>") },
      ]);
      $(".ctab[data-tab='preview']").click();
      await vi.advanceTimersByTimeAsync(0);
      const [own, before, other, out] = loadPreview(
        // The host spelled differently is still the same address.
        `<a href="https://NEWSLETTER.example.com/email/t0k3n">View in browser</a><a href="${ARCHIVE}/owls-at-dusk">Its archive address</a><a href="${ARCHIVE}/herons">Herons</a><a href="https://x.example">x</a>`,
      );
      expect(own!.getAttribute("href")).toBe(webUrl());
      expect(own!.target).toBe("_blank");
      expect(own!.rel).toBe("noopener noreferrer");
      // Its archive address, which no email carries, and another post's page are left alone.
      expect(before!.getAttribute("href")).toBe(`${ARCHIVE}/owls-at-dusk`);
      expect(other!.getAttribute("href")).toBe(`${ARCHIVE}/herons`);
      expect(other!.target).toBe("_blank");
      expect(out!.getAttribute("href")).toBe("https://x.example");
      expect(fake.unhandled).toEqual([]);
    });

    it("opens a scheduled post's web version from its frozen copy", async () => {
      const post = scheduledPost();
      await open(post.routes);
      const [own, other] = loadPreview(
        `<a href="${UNLISTED}">View in browser</a><a href="${ARCHIVE}/herons">Herons</a>`,
      );
      expect(own!.getAttribute("href")).toBe(webUrl());
      expect(own!.target).toBe("_blank");
      expect(other!.getAttribute("href")).toBe(`${ARCHIVE}/herons`);
      expect(fake.unhandled).toEqual([]);
    });
  });

  it("links to the web version in a new tab, and a click saves pending edits without holding the link", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
    ]);
    const link = $<HTMLAnchorElement>("#webLink");
    expect(link.tagName).toBe("A");
    expect(link.textContent).toBe("Web version ↗");
    expect(link.classList.contains("ghost")).toBe(true);
    expect(link.getAttribute("href")).toBe(`${location.origin}${location.pathname}#/web/post/p1`);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener");
    expect(link.getAttribute("aria-label")).toBe("Web version (opens in a new tab)");
    typeInto(body(), "changed");
    // The link is left to do what a link does; the test stops it there, since the document
    // has nowhere to go.
    let prevented: boolean | null = null;
    window.addEventListener(
      "click",
      (e) => {
        prevented = e.defaultPrevented;
        e.preventDefault();
      },
      { once: true },
    );
    link.click();
    expect(prevented).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.json()).toMatchObject({ markdown: "changed", base_revision: "r1" });
    expect($("#saveStatus").textContent).toBe("Saved");
    expect(fake.unhandled).toEqual([]);
  });

  it("saves once when the web version opens in place, while its save is in flight", async () => {
    const server = draftServer();
    let release = () => {};
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        // The click's save is held open, so the leave below comes while it is in flight.
        reply: (req) =>
          server.put(
            req,
            (r) =>
              new Promise((resolve) => {
                release = () => resolve(server.apply(r));
              }),
          ),
      },
    ]);
    window.addEventListener("click", (e) => e.preventDefault(), { once: true });
    typeInto(body(), "changed");
    $("#webLink").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    // In place, the link is a hash change: the router asks the editor to leave, and the
    // leave waits for the click's save, which already carries the edit.
    expect(handle().beforeLeave()).toBe("leave");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.json()).toMatchObject({ markdown: "changed", base_revision: "r1" });
    expect($("#toasts").textContent).toBe("");
  });

  it("sends a leave's edits after a save in flight, on the revision that save made", async () => {
    const server = draftServer();
    let release = () => {};
    let held = false;
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: (req) =>
          server.put(req, (r) => {
            if (held) {
              return undefined;
            }
            held = true;
            return new Promise((resolve) => {
              release = () => resolve(server.apply(r));
            });
          }),
      },
    ]);
    typeInto(body(), "first");
    $<HTMLInputElement>("#f-subject").dispatchEvent(new Event("blur")); // a blur's save
    await vi.advanceTimersByTimeAsync(0);
    typeInto(body(), "second"); // typed while it is in flight
    expect(handle().beforeLeave()).toBe("leave");
    release();
    await vi.advanceTimersByTimeAsync(0);
    // A base taken at the leave would be r1, and the server would refuse our own edit as
    // another writer's.
    expect(puts().map((c) => c.json())).toMatchObject([
      { markdown: "first", base_revision: "r1" },
      { markdown: "second", base_revision: "r2" },
    ]);
    expect($("#toasts").textContent).toBe("");
  });

  it("sends a test to each address, pre-filled from the settings defaults, and shows the warnings", async () => {
    await open([
      { path: "/api/posts/p1", reply: () => draft() },
      {
        path: "/api/settings",
        reply: () => ({ settings: { testRecipients: ["me@b.c", "you@b.c"] } }),
      },
      {
        method: "POST",
        path: "/api/posts/p1/test",
        reply: () => ({ sent: true, warnings: ["An image has no alt text."] }),
      },
    ]);
    $("#testBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    const to = $<HTMLTextAreaElement>("#testTo");
    expect(to.value).toBe("me@b.c\nyou@b.c");
    expect($("#testDefaultsHint").hidden).toBe(false);
    $("#tGo").click();
    await vi.advanceTimersByTimeAsync(0);
    const tests = fake.calls.filter((c) => c.url.pathname === "/api/posts/p1/test");
    expect(tests.map((c) => c.json())).toEqual([{ to: "me@b.c" }, { to: "you@b.c" }]);
    expect($("#toasts").textContent).toMatch(/Test sent to 2 addresses/);
    expect($("#warnings").textContent).toMatch(/Warnings: An image has no alt text\./);
    expect(document.querySelector(".modal")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  // DESIGN §4: no provider is a standing state, so the dialog says so every time it opens
  // and points to the step that connects one, rather than letting the server refuse.
  it("carries a standing line to connect a provider while none is connected, with no recipients, and won't send", async () => {
    appState.appConfig = settingsResponse({ deployment: { provider: "none" } });
    await open([
      { path: "/api/posts/p1", reply: () => draft() },
      { path: "/api/settings", reply: () => ({ settings: { testRecipients: ["me@b.c"] } }) },
    ]);
    $("#testBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    const line = $(".modal .not-connected");
    expect(line.textContent).toBe(
      "No email provider connected, so a test can’t be sent yet. Connect Amazon SES to send one.",
    );
    expect($<HTMLAnchorElement>("a", line).getAttribute("href")).toBe("#/docs/ses");
    expect($<HTMLButtonElement>("#tGo").disabled).toBe(true);
    expect(document.querySelector(".modal #testTo")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("carries no such line once a provider is set, nor on the local stand-in", async () => {
    for (const provider of ["ses", "fake"] as const) {
      appState.appConfig = settingsResponse({ deployment: { provider } });
      await open([
        { path: "/api/posts/p1", reply: () => draft() },
        { path: "/api/settings", reply: () => ({ settings: { testRecipients: [] } }) },
      ]);
      $("#testBtn").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector(".modal .not-connected"), provider).toBeNull();
      expect($<HTMLButtonElement>("#tGo").disabled, provider).toBe(false);
      $("#tCancel").click();
      unmount();
      fake.restore();
    }
  });

  it("names a test recipient that isn't an address and sends nothing, instead of testing fewer people", async () => {
    await open([
      { path: "/api/posts/p1", reply: () => draft() },
      { path: "/api/settings", reply: () => ({ settings: { testRecipients: [] } }) },
    ]);
    $("#testBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    typeInto($<HTMLTextAreaElement>("#testTo"), "me@example.com, typo@gmail");
    $("#tGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((c) => c.url.pathname === "/api/posts/p1/test")).toEqual([]);
    // Said under the recipients, inside the dialog left open to fix the typo.
    expect($(".modal .field-error").textContent).toMatch(/Not an email address: typo@gmail/);
    expect($<HTMLTextAreaElement>("#testTo").classList.contains("is-invalid")).toBe(true);
    expect($("#toasts").textContent).toBe("");
    expect(fake.unhandled).toEqual([]);
  });

  it("says an autosave failed, and has a leave ask rather than flush again", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: () => jsonResponse({ error: "internal_error", message: "disk full" }, 500),
      },
    ]);
    typeInto(body(), "mine");
    await vi.advanceTimersByTimeAsync(5000);
    expect(puts()).toHaveLength(1);
    // Said on the save cue, which keeps it until a save succeeds, not in a passing toast.
    expect($("#saveStatus").textContent).toBe("Not saved: disk full");
    expect($("#saveStatus").classList.contains("is-error")).toBe(true);
    expect($("#toasts").textContent).toBe("");
    expect(handle().dirty()).toBe(true);
    expect(handle().beforeLeave()).toBe("confirm"); // a silent flush would fail again
  });

  it("keeps one retry pending however many saves fail meanwhile", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: () => jsonResponse({ error: "internal_error" }, 503),
      },
    ]);
    typeInto(body(), "one");
    $("#saveBtn").click(); // a failure the publisher caused
    await vi.advanceTimersByTimeAsync(0);
    typeInto(body(), "two");
    $("#saveBtn").click(); // and another, before the retry is due
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(puts()).toHaveLength(3);
    // A second chain would fire here too; the one retry, having failed, waits twice as long.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(puts()).toHaveLength(3);
  });

  it("tries a save again after a dropped connection, but not after a failure in the page itself", async () => {
    const server = draftServer();
    const failures = [
      new TypeError("Failed to fetch"), // no answer: the browser's network failure
      new TypeError("Cannot read properties of undefined (reading 'slug')"), // a bug
    ];
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: () => {
          throw failures.shift() ?? new Error("no more saves were expected");
        },
      },
    ]);
    typeInto(body(), "mine");
    $("#saveBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#saveStatus").textContent).toBe(
      "Not saved: Couldn’t reach Kestrel. Check your connection and try again.",
    );
    await vi.advanceTimersByTimeAsync(5_000); // the dropped connection is tried again
    expect(puts()).toHaveLength(2);
    // The bug would fail the same way every time, so nothing more is sent.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(puts()).toHaveLength(2);
    expect($("#saveStatus").classList.contains("is-error")).toBe(true);
  });

  it("calls off a retry an earlier failure armed once a save is refused on a field", async () => {
    const server = draftServer();
    const replies = [
      () => jsonResponse({ error: "internal_error" }, 503),
      () =>
        jsonResponse(
          { error: "bad_request", message: "That subject is too long.", field: "subject" },
          400,
        ),
    ];
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: (req) => (replies.shift() ?? (() => server.put(req)))(),
      },
    ]);
    typeInto(body(), "one");
    $("#saveBtn").click(); // fails on the server's side: a retry is armed for five seconds on
    await vi.advanceTimersByTimeAsync(0);
    typeInto(body(), "two");
    $("#saveBtn").click(); // refused on the subject, before the retry is due
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(2);
    expect($("#saveStatus").textContent).toBe("Not saved: fix the field marked above.");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(puts()).toHaveLength(2); // the refused subject is not sent again
  });

  it("spaces a later dropped connection's retries from the start once a refusal called off the last", async () => {
    const server = draftServer();
    const replies = [
      () => jsonResponse({ error: "internal_error" }, 503),
      () => jsonResponse({ error: "bad_request", message: "That isn’t allowed." }, 400),
      () => jsonResponse({ error: "internal_error" }, 503),
    ];
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: (req) => (replies.shift() ?? (() => server.put(req)))(),
      },
    ]);
    typeInto(body(), "one");
    $("#saveBtn").click(); // fails on the server's side: a retry is armed for five seconds on
    await vi.advanceTimersByTimeAsync(0);
    typeInto(body(), "two");
    $("#saveBtn").click(); // refused, before the retry is due, which calls it off
    await vi.advanceTimersByTimeAsync(0);
    typeInto(body(), "three");
    $("#saveBtn").click(); // the server's trouble again: a fresh start, not twice as far off
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(puts()).toHaveLength(4);
    expect($("#saveStatus").textContent).toBe("Saved");
  });

  it("drops a failed save's reason once the text is back to what was saved", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: () => jsonResponse({ error: "internal_error" }, 503),
      },
    ]);
    const saved = body().value;
    typeInto(body(), `${saved} more`);
    $("#saveBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#saveStatus").classList.contains("is-error")).toBe(true);
    typeInto(body(), saved); // undone
    expect($("#saveStatus").textContent).toBe("Saved");
    typeInto(body(), `${saved}!`); // a new edit starts clean, not with the old failure
    expect($("#saveStatus").textContent).toBe("Unsaved changes");
    expect(handle().beforeLeave()).not.toBe("confirm");
  });

  it("tries a failed save again on its own, spaced out, and clears the error once one lands", async () => {
    const server = draftServer();
    let failures = 2;
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: (req) =>
          failures-- > 0 ? jsonResponse({ error: "internal_error" }, 503) : server.put(req),
      },
    ]);
    typeInto(body(), "mine");
    await vi.advanceTimersByTimeAsync(5000);
    expect(puts()).toHaveLength(1);
    expect($("#saveStatus").textContent).toBe(
      "Not saved: Something went wrong on the server. Try again in a moment.",
    );
    await vi.advanceTimersByTimeAsync(5000); // the first retry, with no edit in between
    expect(puts()).toHaveLength(2);
    expect($("#saveStatus").classList.contains("is-error")).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); // spaced out: the next is twice as far off
    expect(puts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(puts()).toHaveLength(3);
    expect($("#saveStatus").textContent).toBe("Saved");
    expect(handle().dirty()).toBe(false);
  });

  it("says a leave's save failed, since no one is left on the page to see it otherwise", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: () => jsonResponse({ error: "internal_error", message: "disk full" }, 500),
      },
    ]);
    typeInto(body(), "leaving");
    expect(handle().beforeLeave()).toBe("leave");
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    expect($("#toasts").textContent).toMatch(/Couldn’t save your changes: disk full/);
  });

  it("locks the draft when a save is refused because it left draft elsewhere", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: () =>
          jsonResponse({ error: "not_draft", message: "the post is no longer a draft" }, 409),
      },
    ]);
    typeInto(body(), "mine");
    await vi.advanceTimersByTimeAsync(5000);
    const banner = $("#freshnessBanner");
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/scheduled elsewhere/);
    expect(document.querySelector("#freshKeep")).toBeNull(); // nothing to keep editing
    expect($("#toasts").textContent).toBe(""); // a conflict, not an error
    expect(handle().beforeLeave()).toBe("confirm");
    typeInto(body(), "mine still");
    await vi.advanceTimersByTimeAsync(30000);
    expect(puts()).toHaveLength(1); // paused while the banner is up
  });

  it("reloads the other writer's version from the out-of-date banner, discarding the unsaved edit", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
    ]);
    server.elsewhere("service");
    await vi.advanceTimersByTimeAsync(10000); // the freshness poll finds Claude's save
    expect($("#freshnessBanner").hidden).toBe(false);
    typeInto(body(), "mine"); // held, since saving waits on the banner
    const before = reads().length;
    $("#freshReload").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toHaveLength(before + 1); // the view re-entered, reading the post again
    expect(body().value).toBe("# Owls\n\nHoot.");
    expect($("#freshnessBanner").hidden).toBe(true);
    expect($("#saveStatus").textContent).toBe("Saved");
    expect(handle().dirty()).toBe(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(puts()).toEqual([]); // the discarded edit is never saved
    expect(fake.unhandled).toEqual([]);
  });

  it("says when only some of a test's addresses were sent", async () => {
    await open([
      { path: "/api/posts/p1", reply: () => draft() },
      { path: "/api/settings", reply: () => ({ settings: { testRecipients: [] } }) },
      {
        method: "POST",
        path: "/api/posts/p1/test",
        reply: (req) => ({ sent: (req.json() as { to: string }).to !== "you@b.c", warnings: [] }),
      },
    ]);
    $("#testBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    typeInto($<HTMLTextAreaElement>("#testTo"), "me@b.c\nyou@b.c");
    $("#tGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((c) => c.url.pathname === "/api/posts/p1/test")).toHaveLength(2);
    // The dialog stays open on the address that didn't get it, so Send again tries only that one.
    expect($(".modal .dialog-error").textContent).toContain("Sent to 1 of 2. Not sent to you@b.c.");
    expect($<HTMLTextAreaElement>("#testTo").value).toBe("you@b.c");
    expect($("#toasts").textContent).toBe("");
    expect(fake.unhandled).toEqual([]);
  });

  it("says why a test wasn't sent, in the server's words, rather than inviting a retry that can't work (SPEC §5)", async () => {
    const message =
      "The provider refused it: ses 400 MessageRejected: Email address is not verified. Sending to this address again gets the same answer until what the provider names is fixed.";
    await open([
      { path: "/api/posts/p1", reply: () => draft() },
      { path: "/api/settings", reply: () => ({ settings: { testRecipients: [] } }) },
      {
        method: "POST",
        path: "/api/posts/p1/test",
        reply: () => ({
          sent: false,
          not_sent: {
            may_have_arrived: false,
            error: "ses 400 MessageRejected: Email address is not verified.",
            message,
          },
          warnings: [],
        }),
      },
    ]);
    $("#testBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    typeInto($<HTMLTextAreaElement>("#testTo"), "you@b.c");
    $("#tGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($(".modal .dialog-error").textContent).toBe(`!${message}`);
    expect($<HTMLTextAreaElement>("#testTo").value).toBe("you@b.c");
    expect(fake.unhandled).toEqual([]);
  });

  it("says a time inside the minimum lead under the picker, in words, before asking the server (SPEC §6)", async () => {
    const server = draftServer(draft({ subject: "Owls" }));
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
      { path: "/api/subscribers", reply: () => ({ counts: { confirmed: 3 } }) },
    ]);
    $("#scheduleBtn").click();
    const when = $<HTMLInputElement>("#schWhen");
    when.value = toLocalInput(new Date(Date.now() + 60_000)); // inside the 5-minute default
    $("#schGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.some((c) => c.url.pathname === "/api/posts/p1/schedule")).toBe(false);
    expect(when.classList.contains("is-invalid")).toBe(true);
    expect($(".modal .field-error").textContent).toBe(
      "!Pick a time at least 5 minutes from now, so there’s time to cancel.",
    );
  });

  it("shows the server's own minimum-lead refusal under the picker as it stands (DESIGN §10)", async () => {
    const server = draftServer(draft({ subject: "Owls" }));
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
      { path: "/api/subscribers", reply: () => ({ counts: { confirmed: 3 } }) },
      {
        method: "POST",
        path: "/api/posts/p1/schedule",
        // The server's clock disagrees with the page's, and its words name its own lead,
        // which the page (on the default five minutes) would not have said.
        reply: () =>
          jsonResponse(
            {
              error: "fire_at_too_soon",
              message: "Pick a time at least 90 seconds from now, so there’s time to cancel.",
              field: "fire_at",
            },
            400,
          ),
      },
    ]);
    $("#scheduleBtn").click();
    $<HTMLInputElement>("#schWhen").value = toLocalInput(new Date(Date.now() + 86_400_000));
    $("#schGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($(".modal .field-error").textContent).toBe(
      "!Pick a time at least 90 seconds from now, so there’s time to cancel.",
    );
    expect($<HTMLInputElement>("#schWhen").classList.contains("is-invalid")).toBe(true);
  });

  it("marks the field a refused save names, and doesn't retry a value the server will refuse again", async () => {
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        reply: () =>
          jsonResponse(
            { error: "bad_request", message: "That subject is too long.", field: "subject" },
            400,
          ),
      },
    ]);
    typeInto(body(), "mine");
    await vi.advanceTimersByTimeAsync(5000);
    expect($("#saveStatus").textContent).toBe("Not saved: fix the field marked above.");
    expect($("#f-subject").classList.contains("is-invalid")).toBe(true);
    expect($("#f-subject + .field-error").textContent).toContain("That subject is too long.");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(puts()).toHaveLength(1);
  });

  it("refuses to schedule without a subject, then schedules at the picked time and re-mounts scheduled", async () => {
    // A "now" before the picked fire time (2026-09-25 15:00 local), so the scheduled
    // banner never reads it as already missed, whenever the suite runs.
    vi.setSystemTime(new Date(2026, 8, 24, 10, 0));
    const server = draftServer(draft({ subject: "" }));
    const sends = sendServer();
    await open([
      ...sends.routes,
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
      {
        method: "POST",
        path: "/api/posts/p1/schedule",
        reply: (req) => {
          const fireAt = (req.json() as { fire_at: string }).fire_at;
          server.apply({ json: () => ({ status: "scheduled" }) } as FakeRequest);
          server.scheduled({ id: "s1", fire_at: new Date(fireAt).getTime(), remade_at: null });
          sends.put(sendRow({ fire_at: new Date(fireAt).getTime() }));
          return { send: { id: "s1" } };
        },
      },
    ]);
    $("#scheduleBtn").click();
    expect($("#f-subject").classList.contains("is-invalid")).toBe(true);
    expect($("#f-subject + .field-error").textContent).toContain(
      "Add a subject before you schedule.",
    );
    expect(document.querySelector(".modal")).toBeNull();
    typeInto($<HTMLInputElement>("#f-subject"), "Owls");
    expect(document.querySelector("#f-subject + .field-error")).toBeNull();
    expect($("#f-subject").classList.contains("is-invalid")).toBe(false);
    $("#scheduleBtn").click();
    const when = $<HTMLInputElement>("#schWhen");
    expect(when.value).not.toBe("");
    when.value = "2026-09-25T15:00";
    $("#schGo").click();
    await vi.advanceTimersByTimeAsync(0);
    const scheduled = fake.calls.find((c) => c.url.pathname === "/api/posts/p1/schedule");
    expect(scheduled?.json()).toEqual({
      fire_at: new Date("2026-09-25T15:00").toISOString(),
      email_only: false,
    });
    expect($("#toasts").textContent).toMatch(/Scheduled for/);
    expect($(".banner-scheduled").textContent).toMatch(/Scheduled for .+ · Sends in /);
    expect(body().readOnly).toBe(true);
  });

  it("does not freeze another writer's revision when the pre-schedule save is refused", async () => {
    const server = draftServer();
    let theirs: string | null = null;
    await open([
      { path: "/api/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/api/posts/p1",
        // Claude saved first, so every save of ours against the older base is refused.
        reply: (req) =>
          server.put(req, () => {
            theirs ??= server.elsewhere("service");
            return jsonResponse(
              {
                error: "stale_revision",
                message: "changed",
                current_revision: theirs,
                author: "service",
              },
              409,
            );
          }),
      },
      { path: "/api/subscribers", reply: () => ({ counts: { confirmed: 42 } }) },
      { method: "POST", path: "/api/posts/p1/schedule", reply: () => ({ send: { id: "s1" } }) },
      { method: "POST", path: "/api/posts/p1/send", reply: () => ({ send: { id: "s2" } }) },
    ]);
    // happy-dom has no layout, so scrollIntoView is only observable as a call.
    const intoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    typeInto(body(), "mine, not theirs");
    $("#scheduleBtn").click();
    $<HTMLInputElement>("#schWhen").value = toLocalInput(new Date(Date.now() + 86_400_000));
    $("#schGo").click();
    await vi.advanceTimersByTimeAsync(0);
    // The save was refused, so nothing was frozen; the dialog is gone and the
    // out-of-date banner it was covering is the next step.
    expect(fake.calls.some((c) => c.url.pathname === "/api/posts/p1/schedule")).toBe(false);
    expect(document.querySelector(".modal")).toBeNull();
    expect($("#freshnessBanner").hidden).toBe(false);
    expect($("#freshnessBanner").textContent).toMatch(/changed elsewhere/);
    expect(intoView).toHaveBeenCalledTimes(1); // and the publisher is looking at it
    // Send now is the same door, and refuses the same way.
    $("#scheduleBtn").click();
    $("#toSendNow").click();
    await vi.advanceTimersByTimeAsync(0);
    $("#snGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.some((c) => c.url.pathname === "/api/posts/p1/send")).toBe(false);
    expect(document.querySelector(".modal")).toBeNull();
    // Our edit is still here, unsaved and undisturbed: the banner decides what happens to it.
    expect(body().value).toBe("mine, not theirs");
    expect(handle().dirty()).toBe(true);
  });

  // DESIGN §4: the schedule dialog says no provider is connected before the publisher picks
  // a time, rather than refusing after they confirm.
  it("carries a standing line in the schedule dialog while no provider is connected, with Schedule disabled and no picker or Send now", async () => {
    appState.appConfig = settingsResponse({ deployment: { provider: "none" } });
    const server = draftServer();
    await open([{ path: "/api/posts/p1", reply: server.get }]);
    $("#scheduleBtn").click();
    const line = $(".modal .not-connected");
    expect(line.textContent).toBe(
      "No email provider connected, so this can’t be scheduled yet. Connect Amazon SES to schedule it.",
    );
    expect($<HTMLAnchorElement>("a", line).getAttribute("href")).toBe("#/docs/ses");
    expect($<HTMLButtonElement>("#schGo").disabled).toBe(true);
    expect(document.querySelector(".modal #schWhen")).toBeNull();
    expect(document.querySelector(".modal #toSendNow")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("schedules as usual once a provider is set, and on the local stand-in", async () => {
    for (const provider of ["ses", "fake"] as const) {
      appState.appConfig = settingsResponse({ deployment: { provider } });
      const server = draftServer();
      await open([
        { path: "/api/posts/p1", reply: server.get },
        { path: "/api/subscribers", reply: () => ({ counts: { confirmed: 1 } }) },
      ]);
      $("#scheduleBtn").click();
      expect(document.querySelector(".modal .not-connected"), provider).toBeNull();
      expect($<HTMLButtonElement>("#schGo").disabled, provider).toBe(false);
      $("#toSendNow").click();
      await vi.advanceTimersByTimeAsync(0);
      expect($<HTMLButtonElement>("#snGo").disabled, provider).toBe(false);
      $("#snCancel").click();
      unmount();
      fake.restore();
    }
  });

  describe("the post's settings in the Schedule dialog (SPEC §5)", () => {
    const routes = (server: ReturnType<typeof draftServer>) => [
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req: FakeRequest) => server.put(req) },
      {
        method: "PUT",
        path: "/api/posts/p1/settings",
        reply: (req: FakeRequest) => server.listing(req),
      },
      { path: "/api/subscribers", reply: () => ({ counts: { confirmed: 3 }, page: { total: 3 } }) },
      {
        method: "POST",
        path: "/api/posts/p1/schedule",
        reply: () => ({ send: { id: "s2", fire_at: Date.now() + 86_400_000 } }),
      },
      {
        method: "POST",
        path: "/api/posts/p1/send",
        reply: () => ({ send: { id: "s2", fire_at: Date.now() + 360_000 } }),
      },
    ];
    const listings = () => fake.calls.filter((c) => c.url.pathname === "/api/posts/p1/settings");

    it("shows the post's settings under the time, which say where it will go", async () => {
      await open(routes(draftServer()));
      $("#scheduleBtn").click();
      expect($("#schHint").textContent).toBe(
        "It sends at the time you pick, with a cancelable window until then.",
      );
      expect($<HTMLInputElement>("#schInclude").checked).toBe(true);
      expect($("#schField").textContent).toBe("/archive/");
      expect($<HTMLInputElement>("#schSlug").value).toBe("owls");
      expect($("#schNote").textContent).toBe("Follows the subject until you type your own.");
      expect(fake.unhandled).toEqual([]);
    });

    it("applies a change only with Send now, and keeps it from Schedule into Send now", async () => {
      await open(routes(draftServer()));
      $("#scheduleBtn").click();
      const include = $<HTMLInputElement>("#schInclude");
      include.checked = false;
      include.dispatchEvent(new Event("change"));
      expect(document.querySelector("#schSlug")).toBeNull(); // no address while email only
      expect(listings()).toHaveLength(0); // nothing saved yet
      expect($("#headEmailOnly").hidden).toBe(true);
      $("#toSendNow").click();
      await vi.advanceTimersByTimeAsync(0);
      expect($<HTMLInputElement>("#schInclude").checked).toBe(false);
      $("#snGo").click();
      await vi.advanceTimersByTimeAsync(0);
      const sent = fake.calls.find((c) => c.url.pathname === "/api/posts/p1/send");
      expect(sent?.json()).toEqual({ email_only: true });
      expect(listings()).toHaveLength(0); // the listing goes with the send itself
    });

    it("leaves the post as it was when the dialog is canceled", async () => {
      await open(routes(draftServer()));
      $("#scheduleBtn").click();
      typeInto($<HTMLInputElement>("#schSlug"), "dusk-owls");
      expect($("#schNote").textContent).toBe(""); // set by hand now
      $("#schCancel").click();
      $("#scheduleBtn").click();
      expect($<HTMLInputElement>("#schSlug").value).toBe("owls");
      expect(listings()).toHaveLength(0);
    });

    it("sends a slug set by hand with the schedule itself", async () => {
      await open(routes(draftServer()));
      $("#scheduleBtn").click();
      typeInto($<HTMLInputElement>("#schSlug"), "dusk-owls");
      $("#schGo").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(listings()).toHaveLength(0);
      const scheduled = fake.calls.find((c) => c.url.pathname === "/api/posts/p1/schedule");
      expect(scheduled?.json()).toMatchObject({ email_only: false, slug: "dusk-owls" });
    });

    it("says a refused address under its field, and keeps the dialog open", async () => {
      const server = draftServer();
      await open([
        ...routes(server).filter((r) => r.path !== "/api/posts/p1/schedule"),
        {
          method: "POST",
          path: "/api/posts/p1/schedule",
          reply: () =>
            jsonResponse(
              {
                error: "slug_taken",
                message: "Another post already has this address. Choose another.",
                field: "slug",
              },
              409,
            ),
        },
      ]);
      $("#scheduleBtn").click();
      typeInto($<HTMLInputElement>("#schSlug"), "spring-update");
      $("#schGo").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector(".modal")).not.toBeNull();
      expect($("#schNote").textContent).toBe(
        "Another post already has this address. Choose another.",
      );
      expect($("#schField").classList.contains("is-invalid")).toBe(true);
      expect(document.activeElement).toBe($("#schSlug"));
    });

    it("starts from the post's listing", async () => {
      await open(routes(draftServer(draft({ email_only: true }))));
      $("#scheduleBtn").click();
      expect($<HTMLInputElement>("#schInclude").checked).toBe(false);
    });
  });

  describe("Post settings (DESIGN §3)", () => {
    const listingRoute = (server: ReturnType<typeof draftServer>) => ({
      method: "PUT",
      path: "/api/posts/p1/settings",
      reply: (req: FakeRequest) => server.listing(req),
    });

    it("sits rightmost in the head, and opens a dialog that saves nothing until Save", async () => {
      const server = draftServer();
      await open([{ path: "/api/posts/p1", reply: server.get }, listingRoute(server)]);
      const head = [...$(".editor-head-right").children].filter(
        (el) => !(el as HTMLElement).hidden,
      );
      expect(head.map((el) => el.textContent?.trim())).toEqual(["Web version ↗", "Post settings"]);
      $("#settingsBtn").click();
      expect($(".modal h3").textContent).toBe("Post settings");
      expect($<HTMLInputElement>("#psInclude").checked).toBe(true);
      expect($(".modal .pub-label").textContent).toBe("Archive address");
      // One URL field: the base fixed, the slug the one part to type.
      expect($("#psField .url-base").textContent).toBe("/archive/");
      expect($<HTMLInputElement>("#psSlug").value).toBe("owls");
      const include = $<HTMLInputElement>("#psInclude");
      include.checked = false;
      include.dispatchEvent(new Event("change"));
      $("#psCancel").click();
      expect(fake.calls.some((c) => c.url.pathname === "/api/posts/p1/settings")).toBe(false);
      expect($("#headEmailOnly").hidden).toBe(true);
      expect(fake.unhandled).toEqual([]);
    });

    it("saves both settings on Save, and marks the head Email only while the post is left out", async () => {
      const server = draftServer();
      await open([{ path: "/api/posts/p1", reply: server.get }, listingRoute(server)]);
      $("#settingsBtn").click();
      const include = $<HTMLInputElement>("#psInclude");
      include.checked = false;
      include.dispatchEvent(new Event("change"));
      $("#psSave").click();
      await vi.advanceTimersByTimeAsync(0);
      const put = fake.calls.find((c) => c.url.pathname === "/api/posts/p1/settings");
      expect(put?.json()).toEqual({ email_only: true });
      expect(document.querySelector(".modal")).toBeNull();
      expect($("#headEmailOnly").hidden).toBe(false);
      // The lists' mark, an envelope and the words, not a pill.
      expect($("#headEmailOnly").className).toBe("email-only-mark");
      expect($("#headEmailOnly").textContent?.trim()).toBe("Email only");
      expect($("#headEmailOnly svg")).not.toBeNull();
      expect(puts()).toHaveLength(0); // no revision: the settings aren't part of the draft
    });

    it("says when another post holds the subject's slug, and saves a slug typed by hand", async () => {
      const server = draftServer();
      server.taken.add("owls");
      server.apply({ json: () => ({}) } as FakeRequest); // the server's answer now says so
      await open([{ path: "/api/posts/p1", reply: server.get }, listingRoute(server)]);
      $("#settingsBtn").click();
      expect($<HTMLInputElement>("#psSlug").value).toBe("owls-2");
      expect($("#psNote").textContent?.trim()).toBe(
        "Another post has owls, so a number was added. You can change it above.",
      );
      typeInto($<HTMLInputElement>("#psSlug"), "dusk-owls");
      expect($("#psNote").textContent).toBe("");
      $("#psSave").click();
      await vi.advanceTimersByTimeAsync(0);
      const put = fake.calls.find((c) => c.url.pathname === "/api/posts/p1/settings");
      expect(put?.json()).toEqual({ slug: "dusk-owls" });
      expect(document.querySelector(".modal")).toBeNull();
    });

    it("keeps the dialog open with the server's words when it refuses the address", async () => {
      const server = draftServer();
      await open([{ path: "/api/posts/p1", reply: server.get }, listingRoute(server)]);
      $("#settingsBtn").click();
      typeInto($<HTMLInputElement>("#psSlug"), "Not A Slug");
      $("#psSave").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector(".modal")).not.toBeNull();
      expect($("#psNote").textContent).toBe("Use lowercase letters and numbers.");
    });

    it("hands an emptied address back to the subject", async () => {
      const server = draftServer(draft({ slug: "custom", slug_auto: false, subject: "Barn owls" }));
      await open([{ path: "/api/posts/p1", reply: server.get }, listingRoute(server)]);
      $("#settingsBtn").click();
      const slug = $<HTMLInputElement>("#psSlug");
      typeInto(slug, "");
      slug.dispatchEvent(new Event("blur"));
      expect($<HTMLInputElement>("#psSlug").value).toBe("barn-owls");
      $("#psSave").click();
      await vi.advanceTimersByTimeAsync(0);
      const put = fake.calls.find((c) => c.url.pathname === "/api/posts/p1/settings");
      expect(put?.json()).toEqual({ slug_auto: true });
    });

    it("names a scheduled post's destination in its banner, in place of the head's mark, and keeps settings open", async () => {
      const post = scheduledPost();
      await open([...post.routes, listingRoute(post.server)]);
      expect($<HTMLInputElement>("#f-subject").readOnly).toBe(true);
      expect($("#schedDest").textContent).toBe("Sends by email and publishes at /archive/owls");
      expect($("#rescheduleSchedule").textContent).toBe("Edit schedule");
      // On a row of its own, apart from the controls that act on the time.
      expect($("#schedDest").closest(".banner-bottom")).not.toBeNull();
      expect($(".banner-top").contains($("#schedDest"))).toBe(false);
      // The archive's link icon is one filled path; the envelope is drawn with a rect.
      const envelope = () => document.querySelector("#schedDestIcon svg rect") !== null;
      expect(envelope()).toBe(false);
      $("#settingsBtn").click();
      const include = $<HTMLInputElement>("#psInclude");
      include.checked = false;
      include.dispatchEvent(new Event("change"));
      $("#psSave").click();
      await vi.advanceTimersByTimeAsync(0);
      expect($("#schedDest").textContent).toBe("Sends by email only");
      // An envelope for a post that goes only by email, in place of the archive's link.
      expect(envelope()).toBe(true);
      // Said once: the banner's line, not a tag after the time, nor the head's mark.
      expect(document.querySelector("#schedWhen .sched-email-only")).toBeNull();
      expect($("#headEmailOnly").hidden).toBe(true);
      expect(puts()).toHaveLength(0);
    });

    it("opens on a draft with the address it has, editable", async () => {
      const server = draftServer(draft({ slug: "custom", slug_auto: false }));
      await open([{ path: "/api/posts/p1", reply: server.get }, listingRoute(server)]);
      $("#settingsBtn").click();
      expect($<HTMLInputElement>("#psSlug").readOnly).toBe(false);
      expect($<HTMLInputElement>("#psSlug").value).toBe("custom");
      expect($("#psNote").textContent).toBe("");
    });
  });

  it("sends now from the schedule dialog's demoted link, naming the audience: confirmed, less the suppressed (SPEC §6)", async () => {
    const server = draftServer();
    // Now plus the lead, rounded up to the minute, as the server answers it.
    const fireAt = Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000;
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
      {
        path: "/api/subscribers",
        // 42 confirmed, 5 suppressed (not all of them confirmed): only the filtered roster's total is the audience.
        reply: (req) =>
          req.url.searchParams.get("status") === "confirmed" &&
          req.url.searchParams.get("suppressed") === "hide"
            ? { counts: { confirmed: 42, suppressed: 5 }, page: { total: 40 } }
            : { counts: { confirmed: 42, suppressed: 5 }, page: { total: 99 } },
      },
      {
        method: "POST",
        path: "/api/posts/p1/send",
        reply: () => ({ send: { id: "s2", fire_at: fireAt } }),
      },
    ]);
    $("#scheduleBtn").click();
    $("#toSendNow").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#snWho").textContent).toBe("40 recipients");
    $("#toSchedule").click();
    expect($("#schGo")).toBeTruthy(); // back to the schedule view, re-wired
    $("#toSendNow").click();
    await vi.advanceTimersByTimeAsync(0);
    $("#snGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.some((c) => c.url.pathname === "/api/posts/p1/send")).toBe(true);
    // The toast names the fire time the server answered, not the lead.
    expect($("#toasts").textContent).toContain(`Sends at ${fmt(fireAt)}, cancelable until then.`);
    expect(document.querySelector(".modal")).toBeNull();
  });

  describe("on Workers Free's limits, a send D1's daily writes may not cover (SPEC §8)", () => {
    async function openWithAudience(total: number, freePlanLimits: boolean) {
      appState.appConfig = settingsResponse({ deployment: { provider: "ses", freePlanLimits } });
      const server = draftServer(draft({ subject: "Owls" }));
      await open([
        { path: "/api/posts/p1", reply: server.get },
        {
          path: "/api/subscribers",
          reply: () => ({ counts: { confirmed: total }, page: { total } }),
        },
      ]);
      $("#scheduleBtn").click();
      await vi.advanceTimersByTimeAsync(0);
    }

    it("warns in the Schedule dialog and Send now, in the send's condition words, and disables nothing", async () => {
      await openWithAudience(DAILY_WRITES_SEND_RECIPIENTS + 1, true);
      const line = $("#schDailyWrites");
      expect(line.hidden).toBe(false);
      expect(line.textContent).toBe(dailyWritesSendWarning(DAILY_WRITES_SEND_RECIPIENTS + 1));
      expect($<HTMLButtonElement>("#schGo").disabled).toBe(false);
      $("#toSendNow").click();
      await vi.advanceTimersByTimeAsync(0);
      expect($("#schDailyWrites").textContent).toBe(
        dailyWritesSendWarning(DAILY_WRITES_SEND_RECIPIENTS + 1),
      );
      expect($<HTMLButtonElement>("#snGo").disabled).toBe(false);
      // One read of the audience serves both views.
      expect(fake.calls.filter((c) => c.url.pathname === "/api/subscribers")).toHaveLength(1);
      expect(fake.unhandled).toEqual([]);
    });

    it("says nothing at the threshold", async () => {
      await openWithAudience(DAILY_WRITES_SEND_RECIPIENTS, true);
      expect($("#schDailyWrites").hidden).toBe(true);
    });

    it("leaves the line out, and reads no audience to schedule, on Workers Paid", async () => {
      await openWithAudience(DAILY_WRITES_SEND_RECIPIENTS + 1, false);
      expect(document.querySelector("#schDailyWrites")).toBeNull();
      expect(fake.calls.some((c) => c.url.pathname === "/api/subscribers")).toBe(false);
    });
  });

  it("floors the picker and words its copy by the deployment's minimum lead, not a number of its own", async () => {
    vi.setSystemTime(new Date(2026, 8, 23, 10, 0, 30));
    appState.appConfig = {
      deployment: { minLeadMs: 60_000 },
    } as unknown as SettingsResponse;
    const server = draftServer();
    await open([
      { path: "/api/posts/p1", reply: server.get },
      { method: "PUT", path: "/api/posts/p1", reply: (req) => server.put(req) },
      { path: "/api/subscribers", reply: () => ({ counts: { confirmed: 3 } }) },
      {
        method: "POST",
        path: "/api/posts/p1/send",
        // 10:00:30 plus the lead, rounded up to the minute, as the server answers it.
        reply: () => ({ send: { id: "s2", fire_at: new Date(2026, 8, 23, 10, 2).getTime() } }),
      },
    ]);
    $("#scheduleBtn").click();
    expect($(".modal .hint").textContent).toBe(
      "It sends at the time you pick, with a cancelable window until then.",
    );
    // One lead plus the minute the picker can't show: 10:00:30 + 2 min, to the minute.
    expect($<HTMLInputElement>("#schWhen").min).toBe("2026-09-23T10:02");
    $("#toSendNow").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($(".modal .hint").textContent).toBe(
      "Sends this draft, as it is now, to your subscribers in 1 to 2 minutes. The post locks until then, and you can cancel any time before it starts sending.",
    );
    $("#snGo").click();
    await vi.advanceTimersByTimeAsync(0);
    // A minute and a half out, not the lead's one minute: the time as rounded.
    expect($("#toasts").textContent).toContain(
      `Sends at ${fmt(new Date(2026, 8, 23, 10, 2).getTime())}, cancelable until then.`,
    );
  });

  it("uploads a picked image and inserts it at the caret", async () => {
    await open([
      { path: "/api/posts/p1", reply: () => draft() },
      {
        method: "POST",
        path: "/api/posts/p1/images",
        reply: () => ({ image: { filename: "owl.png", url: "http://m/owl.png" } }),
      },
    ]);
    body().setSelectionRange(0, 0); // the caret is where the snippet lands
    const input = $<HTMLInputElement>("#imgInput");
    const file = new File(["png"], "owl.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(0);
    expect(body().value).toMatch(/^\n!\[owl\.png\]\(owl\.png\)\n# Owls/);
    expect($("#toasts").textContent).toMatch(/Image added/);
    expect($("#saveStatus").textContent).toBe("Unsaved changes");
  });

  it("mounts a scheduled post read-only, with no autosave", async () => {
    await open(scheduledPost().routes);
    expect(body().readOnly).toBe(true);
    expect(document.querySelector("#saveBtn")).toBeNull(); // no save row at all
    typeInto(body(), "nope");
    await vi.advanceTimersByTimeAsync(30000);
    expect(puts()).toHaveLength(0);
  });

  it("disables Cancel and Reschedule in place at the fire time, when the review window closes", async () => {
    await open(scheduledPost(Date.now() + 5_000).routes);
    expect($<HTMLElement>("#schedControls").hidden).toBe(false);
    expect($("#cancelSchedule").textContent).toBe("Cancel");
    expect($<HTMLButtonElement>("#cancelSchedule").disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect($<HTMLElement>("#schedControls").hidden).toBe(false);
    expect($<HTMLButtonElement>("#rescheduleSchedule").disabled).toBe(true);
    expect($<HTMLButtonElement>("#cancelSchedule").disabled).toBe(true);
    expect($("#schedWhen").textContent).toMatch(/· Preparing to send…$/);
  });

  it("switches to Preparing to send at the fire time itself, on the page's clock, with no read", async () => {
    // Half a second off the once-a-second tick, so only a switch at the moment itself passes.
    await open(scheduledPost(Date.now() + 5_500).routes);
    const calls = fake.calls.length;
    await vi.advanceTimersByTimeAsync(5_499);
    expect($<HTMLElement>("#schedControls").hidden).toBe(false);
    expect($("#schedWhen").textContent).toMatch(/Sends in 0s/);
    await vi.advanceTimersByTimeAsync(1);
    expect($("#schedWhen").textContent).toMatch(/^Scheduled for .+ · Preparing to send…$/);
    expect($<HTMLButtonElement>("#rescheduleSchedule").disabled).toBe(true);
    expect($<HTMLButtonElement>("#cancelSchedule").disabled).toBe(true);
    expect(fake.calls).toHaveLength(calls); // nothing was read to get here
  });

  it("keeps Cancel and Reschedule disabled after the fire time when a read still lists them", async () => {
    const linked = scheduledPost(Date.now() + 5_000);
    await open(linked.routes);
    await vi.advanceTimersByTimeAsync(5_000);
    expect($<HTMLButtonElement>("#rescheduleSchedule").disabled).toBe(true);
    expect($<HTMLButtonElement>("#cancelSchedule").disabled).toBe(true);
    // A read whose clock is behind the page's: still scheduled, still offering both.
    linked.sends.edit(
      "s1",
      {},
      {
        phase: "scheduled",
        actions: [
          { name: "cancel", method: "POST", path: "/api/sends/s1/cancel" },
          { name: "reschedule", method: "POST", path: "/api/sends/s1/reschedule" },
        ],
      },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(feedReads(fake)).toHaveLength(2); // at the fire time, then the one carrying the edit
    expect($<HTMLButtonElement>("#rescheduleSchedule").disabled).toBe(true);
    expect($<HTMLButtonElement>("#cancelSchedule").disabled).toBe(true);
    expect($("#schedWhen").textContent).toMatch(/· Preparing to send…$/);
  });

  it("keeps Cancel disabled when a cancel pressed just before the fire time answers after it", async () => {
    let answer: (r: Response) => void = () => {};
    await open([
      ...scheduledPost(Date.now() + 5_000).routes,
      {
        method: "POST",
        path: "/api/sends/s1/cancel",
        reply: () => new Promise<Response>((resolve) => (answer = resolve)),
      },
    ]);
    await vi.advanceTimersByTimeAsync(4_500);
    $("#cancelSchedule").click();
    await vi.advanceTimersByTimeAsync(1_000); // past the fire time, the cancel still in flight
    answer(jsonResponse({ error: "window_closed", message: "the review window has closed" }, 409));
    await vi.advanceTimersByTimeAsync(0);
    expect($<HTMLButtonElement>("#cancelSchedule").disabled).toBe(true);
    expect($<HTMLButtonElement>("#rescheduleSchedule").disabled).toBe(true);
  });

  it("goes to Drafts when a cancel finds the send deleted with its post elsewhere", async () => {
    const linked = scheduledPost();
    await open([
      ...linked.routes,
      {
        method: "POST",
        path: "/api/sends/s1/cancel",
        reply: () => {
          linked.sends.remove("s1"); // deleted before the follow's next read noticed
          return jsonResponse({ error: "not_found", message: "send not found" }, 404);
        },
      },
    ]);
    $("#cancelSchedule").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(location.hash).toBe("#/drafts");
    expect($("#toasts").textContent).toBe("This post was deleted elsewhere.");
    readSendsNow(); // the follow finds the send gone too, and says nothing more
    await vi.advanceTimersByTimeAsync(0);
    expect($("#toasts").textContent).toBe("This post was deleted elsewhere.");
  });

  it("says plainly that a cancel refused at the fire time is too late and the email is going out, and hands off to the live watch as it starts", async () => {
    const linked = scheduledPost(Date.now() + 60_000);
    await open([
      ...linked.routes,
      {
        method: "POST",
        path: "/api/sends/s1/cancel",
        reply: () => {
          // The server's clock passed the fire time while the request was out, and the
          // sweep started the send.
          linked.start();
          return jsonResponse(
            { error: "window_closed", message: "the review window has closed" },
            409,
          );
        },
      },
    ]);
    $("#cancelSchedule").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#toasts").textContent).toMatch(
      /^Too late to cancel: the send time has passed, so this email is going out\./,
    );
    expect($("#toasts").textContent).not.toMatch(/review window/);
    expect(location.hash).toBe("#/sent/s1"); // the follow read at once and handed off
    expect(fake.unhandled).toHaveLength(0);
  });

  it("keeps the window closed after a cancel refused at the fire time, on a page whose clock is behind", async () => {
    await open([
      ...scheduledPost(Date.now() + 60_000).routes,
      {
        method: "POST",
        path: "/api/sends/s1/cancel",
        reply: () =>
          jsonResponse({ error: "window_closed", message: "the review window has closed" }, 409),
      },
    ]);
    $("#cancelSchedule").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($<HTMLButtonElement>("#cancelSchedule").disabled).toBe(true);
    expect($<HTMLButtonElement>("#rescheduleSchedule").disabled).toBe(true);
    expect($("#schedWhen").textContent).toMatch(/· Preparing to send…$/);
    expect(location.hash).toBe("#/edit/p1"); // not started yet: the follow hands off when it does
  });

  it("offers only the window controls the server lists for the send", async () => {
    const linked = scheduledPost();
    linked.sends.edit(
      "s1",
      {},
      { actions: [{ name: "cancel", method: "POST", path: "/api/sends/s1/cancel" }] },
    );
    await open(linked.routes);
    expect($<HTMLElement>("#schedControls").hidden).toBe(false);
    expect($<HTMLElement>("#cancelSchedule").hidden).toBe(false);
    expect($<HTMLElement>("#rescheduleSchedule").hidden).toBe(true);
  });

  it("says a re-made send needs a test in its banner, and the line goes once a test lands (SPEC §8)", async () => {
    const linked = scheduledPost(Date.now() + 86_400_000, Date.now() - 60_000);
    await open([
      ...linked.routes,
      { path: "/api/settings", reply: () => ({ settings: { testRecipients: [] } }) },
      {
        method: "POST",
        path: "/api/posts/p1/test",
        reply: () => {
          linked.sends.edit("s1", { tested_at: Date.now() }); // the server settles the condition
          return { sent: true, warnings: [] };
        },
      },
    ]);
    expect($("#schedRemade").hidden).toBe(false);
    $("#testBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    typeInto($<HTMLTextAreaElement>("#testTo"), "me@example.com");
    $("#tGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".modal")).toBeNull();
    // The feed is read at once after the test, not at the next idle read.
    await vi.advanceTimersByTimeAsync(0);
    expect($("#schedRemade").hidden).toBe(true);
    expect(fake.unhandled).toEqual([]);
  });

  it("a scheduled post: the re-made line shows, an attempted edit nudges the foot, and Cancel returns it to a draft", async () => {
    // Relative to now, so the send stays ahead of its fire time and the re-make behind it
    // whatever day the suite runs.
    const linked = scheduledPost(Date.now() + 86_400_000, Date.now() - 86_400_000);
    await open([
      ...linked.routes,
      {
        method: "POST",
        path: "/api/sends/s1/cancel",
        reply: () => {
          linked.cancel();
          return { send: { id: "s1", status: "canceled" } };
        },
      },
    ]);
    expect($("#schedRemadeMsg").textContent).toBe(
      "The template or publication details changed this email’s look after your last test. Its content and send time are the same. Send a new test to check what will go out.",
    );
    body().dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await vi.advanceTimersByTimeAsync(16);
    expect($("#lockFoot").classList.contains("nudge")).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect($("#lockFoot").classList.contains("nudge")).toBe(false);
    $("#cancelSchedule").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.some((c) => c.url.pathname === "/api/sends/s1/cancel")).toBe(true);
    expect($("#toasts").textContent).toMatch(/Schedule canceled/);
    expect(document.querySelector(".banner-scheduled")).toBeNull();
    expect(body().readOnly).toBe(false);
    expect($("#saveStatus").textContent).toBe("Saved");
  });
});
