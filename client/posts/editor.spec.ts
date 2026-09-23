import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewHandle } from "../lifecycle";
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
  typeInto,
  unmount,
} from "../test/support";
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

  it("redirects a sent post to its record and a post in flight to the live watch", async () => {
    await open([
      { path: "/posts/p1", reply: () => ({ ...draft({ status: "sent" }), sent: { id: "x9" } }) },
    ]);
    expect(location.hash).toBe("#/sent/x9");
    location.hash = "#/edit/p1";
    fake.restore();
    await open([{ path: "/posts/p1", reply: () => ({ ...draft(), sending: { id: "x8" } }) }]);
    expect(location.hash).toBe("#/sent/x8");
    expect(document.querySelector("#f-markdown")).toBeNull(); // never mounted
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

  it("refuses to schedule without a subject, then schedules at the picked time and re-mounts scheduled", async () => {
    const server = draftServer(draft({ subject: "" }));
    await open([
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
      {
        method: "POST",
        path: "/posts/p1/schedule",
        reply: (req) => {
          const fireAt = (req.json() as { fire_at: string }).fire_at;
          server.apply({ json: () => ({ status: "scheduled" }) } as FakeRequest);
          server.scheduled({ id: "s1", fire_at: new Date(fireAt).getTime(), remade_at: null });
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
    expect($(".banner-scheduled").textContent).toMatch(/cancelable until it sends/);
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
    await open([
      {
        path: "/posts/p1",
        reply: () => ({
          ...draft({ status: "scheduled" }),
          scheduled: { id: "s1", fire_at: "2026-09-25T15:00:00Z" },
        }),
      },
    ]);
    expect(body().readOnly).toBe(true);
    expect(document.querySelector("#saveBtn")).toBeNull(); // no save row at all
    typeInto(body(), "nope");
    await vi.advanceTimersByTimeAsync(30000);
    expect(puts()).toHaveLength(0);
  });

  it("a scheduled post: the applied notice shows once, an attempted edit nudges the foot, and Cancel returns it to a draft", async () => {
    const server = draftServer(draft({ status: "scheduled" }));
    server.scheduled({ id: "s1", fire_at: 1_800_000_000_000, remade_at: 1_790_000_000_000 });
    await open([
      { path: "/posts/p1", reply: server.get },
      {
        method: "POST",
        path: "/sends/s1/cancel",
        reply: () => {
          server.apply({ json: () => ({ status: "draft" }) } as FakeRequest);
          server.scheduled(null);
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
