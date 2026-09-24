import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendSummary } from "../../shared/sends";
import type { SettingsResponse } from "../../shared/settings";
import type { ViewHandle } from "../lifecycle";
import { appState } from "../state";
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
  sendServer,
  typeInto,
  unmount,
} from "../test/support";
import { toLocalInput } from "../ui/format";
import { renderEditor } from "./editor";

type Draft = {
  post: Record<string, unknown>;
  markdown: string;
  author: string | null;
  scheduled?: { id: string; fire_at: number; remade_at: number | null } | null;
};

const draft = (over: Record<string, unknown> = {}): Draft => ({
  post: {
    id: "p1",
    subject: "Owls",
    slug: "owls",
    status: "draft",
    current_revision: "r1",
    updated_at: "2026-09-20T10:00:00Z",
    ...over,
  },
  markdown: "# Owls\n\nHoot.",
  author: "a@b.c",
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
      state = { ...state, post: { ...state.post, ...body, current_revision: `r${n}` } };
      return { post: state.post };
    },
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

/** A scheduled send's row, as the send routes store it. */
const sendRow = (over: Partial<SendSummary> = {}): SendSummary => ({
  id: "s1",
  post_id: "p1",
  status: "scheduled",
  fire_at: Date.now() + 3_600_000,
  subject: "Owls",
  recipient_count: 40,
  locked_until: null,
  scheduled_at: Date.now(),
  started_at: null,
  completed_at: null,
  audience_resolved_at: null,
  remade_at: null,
  tested_at: null,
  halt_reason: null,
  halt_cause: null,
  halt_error: null,
  halted_at: null,
  halt_retries: 0,
  halt_retry_at: null,
  c_pending: 0,
  c_in_flight: 0,
  c_accepted: 0,
  c_delivered: 0,
  c_bounced: 0,
  c_complained: 0,
  c_skipped: 0,
  c_unsent: 0,
  rev: 1,
  ...over,
});

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
  const postRoute: FakeRoute = { path: "/posts/p1", reply: () => ({ ...post.get(), sending }) };
  return {
    sends,
    postRoute,
    routes: [
      postRoute,
      // A scheduled post opens on Preview, its frozen email.
      { path: "/posts/p1/preview", reply: () => new Response("<p>Owls</p>") },
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
  const puts = () => fake.calls.filter((c) => c.method === "PUT");
  const body = () => $<HTMLTextAreaElement>("#f-markdown");

  it("mounts a draft into its fields and reads as saved", async () => {
    await open([{ path: "/posts/p1", reply: () => draft() }]);
    expect($<HTMLInputElement>("#f-subject").value).toBe("Owls");
    expect($<HTMLInputElement>("#f-slug").value).toBe("owls");
    expect(body().value).toBe("# Owls\n\nHoot.");
    expect($("#saveStatus").textContent).toBe("Saved");
    expect(handle().dirty()).toBe(false);
  });

  it("marks an edit dirty, then autosaves it after the idle pause with the base revision", async () => {
    const server = draftServer();
    await open([
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
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
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
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
      { path: "/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/posts/p1",
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
      { path: "/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/posts/p1",
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
    await open([{ path: "/posts/p1", reply: server.get }]);
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
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
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
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
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
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
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
      { path: "/posts/p1", reply: () => ({ ...draft({ status: "sent" }), sent: { id: "x9" } }) },
    ]);
    expect(location.hash).toBe("#/sent/x9");
    expect(replace).toHaveBeenLastCalledWith("#/sent/x9"); // so Back skips the editor URL
    location.hash = "#/edit/p1";
    fake.restore();
    await open([{ path: "/posts/p1", reply: () => ({ ...draft(), sending: { id: "x8" } }) }]);
    expect(location.hash).toBe("#/sent/x8");
    expect(replace).toHaveBeenLastCalledWith("#/sent/x8");
    expect(document.querySelector("#f-markdown")).toBeNull(); // never mounted
  });

  const reads = () =>
    fake.calls.filter((c) => c.method === "GET" && c.url.pathname === "/posts/p1");
  const feedCalls = () => fake.calls.filter((c) => c.url.pathname === "/sends/feed");
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  };

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
    await open(linked.routes);
    expect(feedCalls()).toHaveLength(1); // the layer's first read, from the send's cursor
    try {
      setHidden(true);
      await vi.advanceTimersByTimeAsync(120_000); // a hidden tab reads nothing
      expect(feedCalls()).toHaveLength(1);
      linked.start();
      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(feedCalls()).toHaveLength(2);
      expect(location.hash).toBe("#/sent/s1");
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
    expect(reads()).toHaveLength(1); // no poll of the post of its own
  });

  it("reads a draft's freshness at once when a hidden tab is shown again", async () => {
    const server = draftServer();
    await open([{ path: "/posts/p1", reply: server.get }]);
    try {
      setHidden(true);
      await vi.advanceTimersByTimeAsync(10000);
      expect(reads()).toHaveLength(1);
      server.elsewhere("service");
      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads()).toHaveLength(2);
      expect($("#freshnessBanner").hidden).toBe(false);
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
  });

  it("stops reading on a shown tab once the editor is torn down", async () => {
    await open([{ path: "/posts/p1", reply: draftServer().get }]);
    unmount();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toHaveLength(1);
  });

  it("counts the banner down on the clock, then says in the same line that the send is being prepared", async () => {
    const linked = scheduledPost(Date.now() + 65_000);
    await open(linked.routes);
    const when = () => $("#schedWhen").textContent;
    expect(when()).toMatch(/^Scheduled for .+ · Sends in 1m 05s · cancelable until then\.$/);
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

  it("shows a move, a re-make, and a cancel made elsewhere, in place", async () => {
    const linked = scheduledPost(Date.now() + 3_600_000);
    await open(linked.routes);
    expect($("#schedWhen").textContent).toMatch(/Sends in 1h/);
    expect(document.querySelector("#editorNotices .notice")).toBeNull();

    linked.move(Date.now() + 2 * 3_600_000); // Claude moves it
    await vi.advanceTimersByTimeAsync(60_000); // within one idle read
    expect($("#schedWhen").textContent).toMatch(/Sends in 1h 59m/);

    linked.remake(Date.now());
    await vi.advanceTimersByTimeAsync(60_000);
    expect($("#editorNotices .notice").textContent).toMatch(/was applied to this post/);

    linked.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect($("#toasts").textContent).toMatch(/canceled elsewhere/);
    expect(document.querySelector(".banner-scheduled")).toBeNull();
    expect(body().readOnly).toBe(false);
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
        path: "/posts/p1",
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
        path: "/sends/s1",
        reply: (req) =>
          failures-- > 0 ? jsonResponse({ error: "down" }, 503) : sendRead?.reply(req),
      },
      ...linked.routes,
    ]);
    expect(body().readOnly).toBe(true);
    expect($("#schedWhen").textContent).toMatch(/Sends in 1h/);
    expect(feedCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000); // the send read is tried again
    expect(feedCalls()).toHaveLength(1); // and the editor follows from it
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
    await open([...linked.routes, { path: "/posts", reply: () => ({ posts: [], page: {} }) }]);
    linked.sends.remove("s1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(location.hash).toBe("#/drafts");
    expect($("#toasts").textContent).toMatch(/deleted elsewhere/);
  });

  it("shows the error with a retry that mounts the draft", async () => {
    let failures = 1;
    await open([
      {
        path: "/posts/p1",
        reply: () => (failures-- > 0 ? jsonResponse({ error: "down" }, 500) : draft()),
      },
    ]);
    expect($("#app .error").textContent).toMatch(/down/);
    $("[data-retry]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($<HTMLInputElement>("#f-subject").value).toBe("Owls");
  });

  it("derives the slug from the subject until the slug is hand-set, and never leaves it empty", async () => {
    await open([{ path: "/posts/p1", reply: () => draft() }]);
    const subject = $<HTMLInputElement>("#f-subject");
    const slug = $<HTMLInputElement>("#f-slug");
    const auto = $<HTMLInputElement>("#f-slug-auto");
    expect(auto.checked).toBe(true); // "owls" is what "Owls" derives to
    typeInto(subject, "Night owls & co");
    expect(slug.value).toBe("night-owls-co");
    typeInto(slug, "custom");
    expect(auto.checked).toBe(false);
    typeInto(subject, "Something else");
    expect(slug.value).toBe("custom"); // hand-set: the subject no longer drives it
    typeInto(slug, "");
    slug.dispatchEvent(new Event("blur"));
    expect(slug.value).toBe("something-else");
    expect(auto.checked).toBe(true);
  });

  it("opens a new post with an empty subject under an Untitled placeholder, tracking the subject from the first keystroke", async () => {
    // What the server makes of a new post: no subject, and its stand-in slug.
    await open([{ path: "/posts/p1", reply: () => draft({ subject: "", slug: "post-3" }) }]);
    const subject = $<HTMLInputElement>("#f-subject");
    const slug = $<HTMLInputElement>("#f-slug");
    expect(subject.value).toBe("");
    expect(subject.placeholder).toBe("Untitled");
    expect($<HTMLInputElement>("#f-slug-auto").checked).toBe(true);
    typeInto(subject, "Welcome to The Compiler");
    expect(subject.value).toBe("Welcome to The Compiler");
    expect(slug.value).toBe("welcome-to-the-compiler");
  });

  it("formats the selection from the toolbar and by shortcut, and marks the draft dirty", async () => {
    await open([{ path: "/posts/p1", reply: () => draft() }]);
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
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
      {
        path: "/posts/p1/preview",
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
    expect(body().hidden).toBe(true);
  });

  it("sends a test to each address, pre-filled from the settings defaults, and shows the warnings", async () => {
    await open([
      { path: "/posts/p1", reply: () => draft() },
      {
        path: "/api/settings",
        reply: () => ({ settings: { testRecipients: ["me@b.c", "you@b.c"] } }),
      },
      {
        method: "POST",
        path: "/posts/p1/test",
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
    const tests = fake.calls.filter((c) => c.url.pathname === "/posts/p1/test");
    expect(tests.map((c) => c.json())).toEqual([{ to: "me@b.c" }, { to: "you@b.c" }]);
    expect($("#toasts").textContent).toMatch(/Test sent to 2 addresses/);
    expect($("#warnings").textContent).toMatch(/Warnings: An image has no alt text\./);
    expect(document.querySelector(".modal")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("names a test recipient that isn't an address and sends nothing, instead of testing fewer people", async () => {
    await open([
      { path: "/posts/p1", reply: () => draft() },
      { path: "/api/settings", reply: () => ({ settings: { testRecipients: [] } }) },
    ]);
    $("#testBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    typeInto($<HTMLTextAreaElement>("#testTo"), "me@example.com, typo@gmail");
    $("#tGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((c) => c.url.pathname === "/posts/p1/test")).toEqual([]);
    expect($("#toasts").textContent).toMatch(/Not an email address: typo@gmail/);
    expect(document.querySelector(".modal")).not.toBeNull(); // left open to fix the typo
    expect(fake.unhandled).toEqual([]);
  });

  it("refuses to schedule without a subject, then schedules at the picked time and re-mounts scheduled", async () => {
    const server = draftServer(draft({ subject: "" }));
    const sends = sendServer();
    await open([
      ...sends.routes,
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
      {
        method: "POST",
        path: "/posts/p1/schedule",
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
    expect($("#f-subject-error").hidden).toBe(false);
    expect(document.querySelector(".modal")).toBeNull();
    typeInto($<HTMLInputElement>("#f-subject"), "Owls");
    expect($("#f-subject-error").hidden).toBe(true);
    $("#scheduleBtn").click();
    const when = $<HTMLInputElement>("#schWhen");
    expect(when.value).not.toBe("");
    when.value = "2026-09-25T15:00";
    $("#schGo").click();
    await vi.advanceTimersByTimeAsync(0);
    const scheduled = fake.calls.find((c) => c.url.pathname === "/posts/p1/schedule");
    expect(scheduled?.json()).toEqual({ fire_at: new Date("2026-09-25T15:00").toISOString() });
    expect($("#toasts").textContent).toMatch(/Scheduled for/);
    expect($(".banner-scheduled").textContent).toMatch(/cancelable until then/);
    expect(body().readOnly).toBe(true);
  });

  it("does not freeze another writer's revision when the pre-schedule save is refused", async () => {
    const server = draftServer();
    let theirs: string | null = null;
    await open([
      { path: "/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/posts/p1",
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
      { path: "/subscribers", reply: () => ({ counts: { confirmed: 42 } }) },
      { method: "POST", path: "/posts/p1/schedule", reply: () => ({ send: { id: "s1" } }) },
      { method: "POST", path: "/posts/p1/send", reply: () => ({ send: { id: "s2" } }) },
    ]);
    // happy-dom has no layout, so scrollIntoView is only observable as a call.
    const intoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    typeInto(body(), "mine, not theirs");
    $("#scheduleBtn").click();
    $<HTMLInputElement>("#schWhen").value = "2026-09-25T15:00";
    $("#schGo").click();
    await vi.advanceTimersByTimeAsync(0);
    // The save was refused, so nothing was frozen; the dialog is gone and the
    // out-of-date banner it was covering is the next step.
    expect(fake.calls.some((c) => c.url.pathname === "/posts/p1/schedule")).toBe(false);
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
    expect(fake.calls.some((c) => c.url.pathname === "/posts/p1/send")).toBe(false);
    expect(document.querySelector(".modal")).toBeNull();
    // Our edit is still here, unsaved and undisturbed: the banner decides what happens to it.
    expect(body().value).toBe("mine, not theirs");
    expect(handle().dirty()).toBe(true);
  });

  it("sends now from the schedule dialog's demoted link, naming the confirmed count", async () => {
    const server = draftServer();
    await open([
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
      { path: "/subscribers", reply: () => ({ counts: { confirmed: 42 } }) },
      { method: "POST", path: "/posts/p1/send", reply: () => ({ send: { id: "s2" } }) },
    ]);
    $("#scheduleBtn").click();
    $("#toSendNow").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#snWho").textContent).toBe("42 confirmed subscribers");
    $("#toSchedule").click();
    expect($("#schGo")).toBeTruthy(); // back to the schedule view, re-wired
    $("#toSendNow").click();
    await vi.advanceTimersByTimeAsync(0);
    $("#snGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.some((c) => c.url.pathname === "/posts/p1/send")).toBe(true);
    expect($("#toasts").textContent).toMatch(/Sends in 5 minutes/);
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("floors the picker and words its copy by the deployment's minimum lead, not a number of its own", async () => {
    vi.setSystemTime(new Date(2026, 8, 23, 10, 0, 30));
    appState.appConfig = {
      deployment: { minLeadMs: 60_000 },
    } as unknown as SettingsResponse;
    try {
      const server = draftServer();
      await open([
        { path: "/posts/p1", reply: server.get },
        { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
        { path: "/subscribers", reply: () => ({ counts: { confirmed: 3 } }) },
        { method: "POST", path: "/posts/p1/send", reply: () => ({ send: { id: "s2" } }) },
      ]);
      $("#scheduleBtn").click();
      expect($(".modal .hint").textContent).toMatch(/at least 1 minute out/);
      // One lead plus the minute the picker can't show: 10:00:30 + 2 min, to the minute.
      expect($<HTMLInputElement>("#schWhen").min).toBe("2026-09-23T10:02");
      $("#toSendNow").click();
      await vi.advanceTimersByTimeAsync(0);
      expect($(".modal .hint").textContent).toMatch(
        /cancelable window of at least 1 minute, on the minute/,
      );
      $("#snGo").click();
      await vi.advanceTimersByTimeAsync(0);
      expect($("#toasts").textContent).toMatch(/Sends in 1 minute,/);
    } finally {
      appState.appConfig = null;
    }
  });

  it("uploads a picked image and inserts it at the caret", async () => {
    await open([
      { path: "/posts/p1", reply: () => draft() },
      {
        method: "POST",
        path: "/posts/p1/images",
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
          { name: "cancel", method: "POST", path: "/sends/s1/cancel" },
          { name: "reschedule", method: "POST", path: "/sends/s1/reschedule" },
        ],
      },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.calls.some((c) => c.url.pathname === "/sends/feed")).toBe(true);
    expect($<HTMLButtonElement>("#rescheduleSchedule").disabled).toBe(true);
    expect($<HTMLButtonElement>("#cancelSchedule").disabled).toBe(true);
    expect($("#schedWhen").textContent).toMatch(/· Preparing to send…$/);
  });

  it("offers only the window controls the server lists for the send", async () => {
    const linked = scheduledPost();
    linked.sends.edit(
      "s1",
      {},
      { actions: [{ name: "cancel", method: "POST", path: "/sends/s1/cancel" }] },
    );
    await open(linked.routes);
    expect($<HTMLElement>("#schedControls").hidden).toBe(false);
    expect($<HTMLElement>("#cancelSchedule").hidden).toBe(false);
    expect($<HTMLElement>("#rescheduleSchedule").hidden).toBe(true);
  });

  it("a scheduled post: the applied notice shows once, an attempted edit nudges the foot, and Cancel returns it to a draft", async () => {
    const linked = scheduledPost(1_800_000_000_000, 1_790_000_000_000);
    await open([
      ...linked.routes,
      {
        method: "POST",
        path: "/sends/s1/cancel",
        reply: () => {
          linked.cancel();
          return { send: { id: "s1", status: "canceled" } };
        },
      },
    ]);
    expect($("#editorNotices .notice").textContent).toMatch(/was applied to this post/);
    body().dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await vi.advanceTimersByTimeAsync(16);
    expect($("#lockFoot").classList.contains("nudge")).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect($("#lockFoot").classList.contains("nudge")).toBe(false);
    $("#cancelSchedule").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.some((c) => c.url.pathname === "/sends/s1/cancel")).toBe(true);
    expect($("#toasts").textContent).toMatch(/Schedule canceled/);
    expect(document.querySelector(".banner-scheduled")).toBeNull();
    expect(body().readOnly).toBe(false);
    expect($("#saveStatus").textContent).toBe("Saved");
  });
});
