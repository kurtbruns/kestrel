import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeliveryOutcomes,
  refusalAdvice,
  type SendSummary,
  type SendView,
} from "../../shared/sends";
import { appState } from "../state";
import { condition, feedReads, sendServer, sendView } from "../test/send_server";
import {
  $,
  $$,
  captureDownloads,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  type SendRowFixture,
  sendSummary,
  settingsResponse,
  stubClipboard,
  typeInto,
  unmount,
} from "../test/support";
import { renderSentRecord } from "./record";

// A send that went out to 10: 8 delivered, 1 bounced, 1 never handed off.
const send = (over: Partial<SendRowFixture> = {}): SendRowFixture =>
  sendSummary({
    status: "sent",
    subject: "Owls",
    recipient_count: 10,
    fire_at: 1_000_000,
    scheduled_at: 900_000,
    started_at: 1_000_000,
    completed_at: 1_001_000,
    audience_resolved_at: 1_000_000,
    c_delivered: 8,
    c_bounced: 1,
    c_unsent: 1,
    ...over,
  });
const outcomes = (over: Partial<DeliveryOutcomes> = {}): DeliveryOutcomes => ({
  recipients: 10,
  delivered: 8,
  bounced: 1,
  complained: 0,
  unsent: 1,
  skipped: 0,
  accepted: 0,
  pending: 0,
  dispatched: 0,
  ...over,
});
const page = { total: 2, limit: 50, offset: 0, sort: "email", dir: "asc" };
const rows = [
  {
    email: "b@x.y",
    status: "accepted",
    event: "bounced",
    event_detail: "550",
    event_at: 1_000_500,
    error: null,
    attempts: 1,
    bounce_kind: "hard",
  },
  {
    email: "u@x.y",
    status: "unsent",
    event: null,
    event_detail: null,
    event_at: null,
    error: "timeout",
    attempts: 3,
    bounce_kind: null,
  },
];

describe("sent record", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
    location.hash = "#/sent/x1";
  });
  afterEach(() => {
    fake?.restore();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // A sent send on the fake server: its read, the feed, and its outcomes all come from its
  // counters, and `receipt` moves them the way a delivery webhook does.
  const sentSend = (over: Partial<SendRowFixture> = {}) => {
    const server = sendServer([send(over)]);
    return {
      routes: server.routes,
      receipt: (counts: Partial<SendSummary>) => server.edit("x1", counts),
      remove: () => server.remove("x1"),
      aheadOnce: server.aheadOnce,
    };
  };
  const SETTLING = { c_delivered: 5, c_bounced: 0, c_unsent: 0, c_accepted: 5 };

  it("names an erased person's row Erased recipient, muted, in place of its placeholder (SPEC §7)", async () => {
    fake = fakeApi([
      ...sentSend().routes,
      {
        path: "/api/sends/x1/deliveries",
        reply: () => ({
          deliveries: [{ ...rows[0], email: "erased:0f3a9c2e7b1d4e8f" }, rows[1]],
          view: "failures",
          page,
        }),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    const cells = $$(".rec-people-table .rec-email");
    expect(cells.map((c) => c.textContent)).toEqual(["Erased recipient", "u@x.y"]);
    expect(cells[0]!.querySelector(".muted")).not.toBeNull();
    expect($(".rec-people-table").textContent).not.toContain("erased:");
  });

  it("names the tab for the send's subject", async () => {
    fake = fakeApi([
      ...sentSend().routes,
      { path: "/api/sends/x1/deliveries", reply: () => ({ deliveries: [], view: "all", page }) },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.title).toBe("Owls - Kestrel");
  });

  it("renders the frozen record: tiles, the reconciliation line, and every recipient first", async () => {
    fake = fakeApi([
      ...sentSend().routes,
      {
        path: "/api/sends/x1/deliveries",
        reply: (req) => ({
          deliveries: req.url.searchParams.get("view") === "all" ? rows : [],
          view: req.url.searchParams.get("view"),
          page,
        }),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($("h1").textContent).toBe("Owls");
    expect($$(".rec-tile")).toHaveLength(5);
    expect($(".rec-recon").textContent).toMatch(
      /All 10 accounted for: 8 delivered, 1 bounced, 1 unsent\..*suppressed automatically/,
    );
    expect($$(".rec-people-table tbody tr")).toHaveLength(2);
    expect($(".rec-people-table tbody tr .rec-out").textContent).toBe("Hard bounce");
    expect($("#recOpen").textContent).toBe("Open\u00a0↗");
    expect(
      fake.calls.find((c) => c.url.pathname.endsWith("/deliveries"))?.url.searchParams.get("view"),
    ).toBe("all");
    expect($(".rec-view-btn[aria-pressed='true']").textContent).toBe("All");
    expect($("#recPill").textContent).toBe("Complete");
    // Nothing moves: the record follows its send at the idle pace, reading the feed and
    // nothing else, never the send's whole record again.
    const others = () => fake.calls.length - feedReads(fake).length;
    const reads = others();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(others()).toBe(reads);
    expect(feedReads(fake)).toHaveLength(3); // the first, then one a minute
    expect(fake.unhandled).toHaveLength(0);
  });

  const noRows = {
    path: "/api/sends/x1/deliveries",
    reply: () => ({ deliveries: [], view: "failures", page: { ...page, total: 0 } }),
  };

  it("reads Settling while receipts arrive, and turns Complete in place when the last lands", async () => {
    const sent = sentSend(SETTLING);
    fake = fakeApi([...sent.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($("#recPill").textContent).toBe("Settling");
    expect($(".rec-meta").textContent).toMatch(/^Sent /);
    const card = $(".rec-card");
    sent.receipt({ c_delivered: 10, c_accepted: 0 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($("#recPill").textContent).toBe("Complete");
    expect($(".rec-card")).toBe(card); // in place, not a remount
    expect($(".rec-n.ok").textContent).toBe("10");
    expect(fake.unhandled).toHaveLength(0);
  });

  it("says, amber, when no receipt has come long after dispatch, and clears it in place when one lands (SPEC §8)", async () => {
    const server = sendServer();
    server.put(send({ c_delivered: 0, c_bounced: 0, c_unsent: 0, c_accepted: 10 }), {
      conditions: [condition.noReceipts(10)],
    });
    fake = fakeApi([...server.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($("#recPill").textContent).toBe("Settling");
    expect($("#recAlert .health.amber").textContent).toMatch(
      /^⚠️No delivery receipt has arrived for any of the 10 recipients/,
    );
    const card = $(".rec-card");
    server.edit("x1", { c_delivered: 1, c_accepted: 9 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect($(".rec-card")).toBe(card);
    expect(document.querySelector("#recAlert .health")).toBeNull();
    expect(fake.unhandled).toHaveLength(0);
  });

  // DESIGN §3: the page in two parts, the post and its delivery. The post holds the one thing
  // that can still change, its listing, never the record (SPEC §5, I3), and both changes of
  // visibility ask first.
  describe("the post, beside its delivery", () => {
    /** The settings route, answering the post as the server would after the change: its
     *  address, and whether that address answers, since the post was sent with the unlisted
     *  link, only while it is listed. */
    const listingRoute = (post: { email_only: boolean; slug?: string }) => ({
      method: "PUT",
      path: "/api/posts/p1/settings",
      reply: () => ({
        post: {
          id: "p1",
          status: "sent",
          archive_url: `https://birds.example/archive/${post.slug ?? "owls"}`,
          archive_live: !post.email_only,
          ...post,
        },
        subject_slug_held: null,
        changed: true,
      }),
    });
    /** The post's read, which Add to archive takes the address from. */
    const postRoute = (post: Record<string, unknown>) => ({
      path: "/api/posts/p1",
      reply: () => ({
        post: {
          id: "p1",
          subject: "Owls at Dusk",
          status: "sent",
          published_at: 1_700_000_000_000,
          ...post,
        },
        subject_slug_held: null,
        markdown: "",
        author: null,
        scheduled: null,
        sending: null,
        sent: { id: "x1" },
      }),
    });
    beforeEach(() => {
      appState.appConfig = {
        ...settingsResponse(),
        deployment: {
          ...settingsResponse().deployment,
          archive_origin: "https://birds.example",
          archive_base_path: "/archive",
        },
      } as typeof appState.appConfig;
    });

    it("splits the page into the post and its delivery, with a listed post's address and its actions", async () => {
      const server = sendServer([send()]);
      fake = fakeApi([...server.routes, noRows]);
      const clipboard = stubClipboard();
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      await mount((r, s) => renderSentRecord("x1", r, s));
      await vi.advanceTimersByTimeAsync(0);
      expect($$(".rec-part-title").map((h) => h.textContent)).toEqual(["The post", "Delivery"]);
      expect($(".rec-post").contains($("#recOpen"))).toBe(true);
      expect($(".rec-card").contains($(".rec-tiles"))).toBe(true);
      // The link is one field, its address with Copy and Open; where the post stands is a row
      // of its own beside the one change it allows.
      expect($(".rec-link code").textContent).toBe("birds.example/p1");
      expect($(".rec-link-note").textContent).toBe("The link in the email forwards here.");
      expect($(".rec-arch-what").textContent?.trim()).toBe(
        "In your archiveListed on your home page and in your public archive.",
      );
      $("#recOpen").click();
      expect(open).toHaveBeenCalledWith("https://birds.example/p1", "_blank", "noopener");
      $("#recCopy").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(clipboard).toHaveBeenCalledWith("https://birds.example/p1");
      expect($("#recListing").textContent).toBe("Remove from archive…");
      expect(fake.unhandled).toHaveLength(0);
    });

    it("asks before removing a post from the archive, and says its archive address stops working", async () => {
      const server = sendServer([send()]);
      fake = fakeApi([...server.routes, noRows, listingRoute({ email_only: true, slug: "owls" })]);
      await mount((r, s) => renderSentRecord("x1", r, s));
      await vi.advanceTimersByTimeAsync(0);
      $("#recListing").click();
      expect($(".modal h3").textContent).toBe("Remove this post from your archive?");
      expect($(".modal .hint").textContent).toContain("its archive address stops working");
      expect($(".modal .url-gone").textContent).toBe("birds.example/p1");
      $("#eoCancel").click();
      expect(document.querySelector(".modal")).toBeNull();
      expect(fake.calls.some((c) => c.url.pathname === "/api/posts/p1/settings")).toBe(false);
      $("#recListing").click();
      $("#eoGo").click();
      await vi.advanceTimersByTimeAsync(0);
      const put = fake.calls.find((c) => c.url.pathname === "/api/posts/p1/settings");
      expect(put?.json()).toEqual({ email_only: true });
      expect(document.querySelector(".modal")).toBeNull();
      // Now its unlisted link, which the email carries, and the way back.
      expect($(".rec-link code").textContent).toBe("app.birds.example/email/t-p1");
      expect($(".rec-link-note").textContent).toBe(
        "Anyone with the link can open it. Nothing lists or indexes it.",
      );
      expect($(".rec-arch-what").textContent?.trim()).toBe(
        "Email onlyNot on your home page or in your public archive.",
      );
      expect($("#recListing").textContent).toBe("Add to archive…");
      expect($("#toasts").textContent).toContain("Removed from your archive");
      expect(fake.unhandled).toHaveLength(0);
    });

    it("adds a post to the archive at the address it was sent with, shown read-only", async () => {
      const server = sendServer();
      server.put(send(), { email_only: true });
      fake = fakeApi([
        ...server.routes,
        noRows,
        postRoute({ slug: "owls", slug_auto: true, email_only: true }),
        listingRoute({ email_only: false, slug: "owls" }),
      ]);
      await mount((r, s) => renderSentRecord("x1", r, s));
      await vi.advanceTimersByTimeAsync(0);
      $("#recListing").click();
      await vi.advanceTimersByTimeAsync(0);
      expect($(".modal h3").textContent).toBe("Add this post to your archive?");
      expect(document.querySelector("#addInclude")).toBeNull(); // adding it is the choice
      expect($<HTMLInputElement>("#addSlug").value).toBe("owls");
      expect($<HTMLInputElement>("#addSlug").readOnly).toBe(true);
      expect($("#addNote").textContent).toBe(
        "Its address since it was sent: links people shared work again.",
      );
      $("#addArchGo").click();
      await vi.advanceTimersByTimeAsync(0);
      const put = fake.calls.find((c) => c.url.pathname === "/api/posts/p1/settings");
      expect(put?.json()).toEqual({ email_only: false });
      expect($("#toasts").textContent).toContain(
        "Added to your archive at birds.example/archive/owls",
      );
      expect($(".rec-link code").textContent).toBe("birds.example/archive/owls");
      expect($(".rec-arch-what strong").textContent?.trim()).toBe("In your archive");
      expect(fake.unhandled).toHaveLength(0);
    });

    it("words a post sent before unlisted links by what its emails link to", async () => {
      const server = sendServer();
      server.put(send(), {
        email_only: true,
        web_link: "archive",
        archive: "https://birds.example/archive/owls",
      });
      fake = fakeApi([...server.routes, noRows]);
      await mount((r, s) => renderSentRecord("x1", r, s));
      await vi.advanceTimersByTimeAsync(0);
      // Its emails link the archive address, which keeps answering: that is its web version.
      expect($(".rec-link code").textContent).toBe("birds.example/archive/owls");
      expect($(".rec-link-note").textContent).toContain("Its emails link here.");
      expect(fake.unhandled).toHaveLength(0);
    });

    it("follows a listing change made elsewhere, from the send's next report", async () => {
      const server = sendServer([send(SETTLING)]);
      fake = fakeApi([...server.routes, noRows]);
      await mount((r, s) => renderSentRecord("x1", r, s));
      await vi.advanceTimersByTimeAsync(0);
      expect($("#recListing").textContent).toBe("Remove from archive…");
      server.edit("x1", {}, { email_only: true }); // Claude made it email only
      await vi.advanceTimersByTimeAsync(3000);
      expect($("#recListing").textContent).toBe("Add to archive…");
      expect(fake.unhandled).toHaveLength(0);
    });
  });

  it("saves the deliveries CSV as the server sends it, under the server's name or deliveries.csv", async () => {
    const csv = "email,outcome\r\nada@example.com,delivered\r\n";
    let disposition: string | null = 'attachment; filename="owls-deliveries.csv"';
    fake = fakeApi([
      ...sentSend().routes,
      noRows,
      {
        path: "/api/sends/x1/deliveries.csv",
        reply: () =>
          new Response(csv, {
            headers: disposition ? { "content-disposition": disposition } : {},
          }),
      },
    ]);
    const saved = captureDownloads();
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    $("#csvBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    disposition = null;
    $("#csvBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.map((f) => f.name)).toEqual(["owls-deliveries.csv", "deliveries.csv"]);
    expect(await saved[0]?.blob.text()).toBe(csv);
    expect(await saved[1]?.blob.text()).toBe(csv);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("says why the deliveries can't be exported: the server's words, or that the send is gone", async () => {
    let answer = jsonResponse({ error: "internal_error", message: "database unavailable" }, 500);
    fake = fakeApi([
      ...sentSend().routes,
      noRows,
      { path: "/api/sends/x1/deliveries.csv", reply: () => answer },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    $("#csvBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#toasts").textContent).toBe("database unavailable");
    resetShell();
    answer = jsonResponse({ error: "not_found", message: "send" }, 404);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    $("#csvBtn").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#toasts").textContent).toBe(
      "This send no longer exists, so there are no deliveries to export.",
    );
    expect(fake.unhandled).toHaveLength(0);
  });

  it("names each leftover recipient for what it is: only an accepted one awaits a receipt", async () => {
    const sent = sentSend({
      c_delivered: 5,
      c_bounced: 0,
      c_unsent: 0,
      c_accepted: 1,
      c_skipped: 2,
      c_pending: 1,
      c_in_flight: 1,
    });
    fake = fakeApi([...sent.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    const recon = () => $(".rec-recon").textContent ?? "";
    expect(recon()).toContain("1 accepted, awaiting a delivery receipt");
    expect(recon()).toContain(
      "2 skipped (unsubscribed or suppressed before hand-off, never mailed)",
    );
    // One not yet handed off is pending, and only one handed over with no answer is in flight.
    expect(recon()).toContain("1 pending, 1 in flight");
    expect(recon()).not.toMatch(/[2-9] accepted, awaiting/);
    // A report whose counters read the same buckets as the page's own read moves nothing.
    const lists = fake.calls.filter((c) => c.url.pathname.endsWith("/deliveries")).length;
    sent.receipt({});
    await vi.advanceTimersByTimeAsync(3000);
    expect(recon()).toContain("1 pending, 1 in flight");
    expect(fake.calls.filter((c) => c.url.pathname.endsWith("/deliveries"))).toHaveLength(lists);
  });

  it("says what each outcome means in the reconciliation line, never on hover (DESIGN §11, SPEC §8)", async () => {
    const outcomeRows = [
      { ...rows[0]!, email: "hard@x.y" },
      { ...rows[0]!, email: "soft@x.y", bounce_kind: "soft" as const },
      { ...rows[0]!, email: "spam@x.y", event: "complained" as const, bounce_kind: null },
      { ...rows[1]!, email: "wait@x.y", status: "accepted" as const, error: null },
    ];
    fake = fakeApi([
      ...sentSend({ c_delivered: 6, c_bounced: 2, c_complained: 1, c_unsent: 0, c_accepted: 1 })
        .routes,
      {
        path: "/api/sends/x1/deliveries",
        reply: () => ({
          deliveries: outcomeRows,
          view: "failures",
          page: { ...page, total: 4 },
        }),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    const outs = $$(".rec-people-table .rec-out");
    expect(outs.map((o) => o.textContent)).toEqual([
      "Hard bounce",
      "Soft bounce",
      "Complained",
      "Accepted",
    ]);
    expect(outs.filter((o) => o.hasAttribute("title"))).toEqual([]);
    expect($(".rec-recon").textContent).toBe(
      "All 10 accounted for: 6 delivered, 2 bounced, 1 complained, 1 accepted, awaiting a delivery receipt." +
        " Hard bounces are suppressed automatically and spam complaints unsubscribe the reader, so those addresses won’t be mailed again." +
        " A soft bounce is temporary, so it’s counted and the address stays on the list.",
    );
    expect(fake.unhandled).toHaveLength(0);
  });

  it("leaves soft bounces out of a send that had none, saying only what suppresses", async () => {
    fake = fakeApi([
      ...sentSend({ c_delivered: 9, c_bounced: 0, c_complained: 1, c_unsent: 0 }).routes,
      noRows,
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($(".rec-recon").textContent).toBe(
      "All 10 accounted for: 9 delivered, 1 complained." +
        " Hard bounces are suppressed automatically and spam complaints unsubscribe the reader, so those addresses won’t be mailed again.",
    );
    expect(fake.unhandled).toHaveLength(0);
  });

  it("reads Canceled for a canceled send, with when, never Sent", async () => {
    fake = fakeApi(
      sentSend({
        status: "canceled",
        started_at: null,
        completed_at: 950_000,
        c_delivered: 0,
        c_bounced: 0,
        c_unsent: 0,
      }).routes,
    );
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($("#recPill").textContent).toBe("Canceled");
    expect($(".rec-meta").textContent).toMatch(/^Canceled /);
    expect($(".rec-card").textContent).not.toMatch(/\bSent\b/);
    expect($(".rec-card").textContent).toMatch(/no one was mailed/);
    expect(document.querySelector(".rec-tiles")).toBeNull();
    expect(fake.unhandled).toHaveLength(0);
  });

  describe("who acted on the send (SPEC §11, DESIGN §3)", () => {
    const by = (actor: object) => JSON.stringify(actor);
    const VIA_CLAUDE = by({ kind: "human", email: "you@example.com", client: "claude-code" });

    it("names who scheduled a sent send and who resolved it, under when it was sent", async () => {
      fake = fakeApi([
        ...sentSend({
          scheduled_by: VIA_CLAUDE,
          resolved_by: by({ kind: "service", token_id: "ci.access", client: null }),
        }).routes,
        noRows,
      ]);
      await mount((r, s) => renderSentRecord("x1", r, s));
      await vi.advanceTimersByTimeAsync(0);
      expect($(".rec-by").textContent).toBe(
        "Scheduled by you@example.com via Claude Code · resolved by the service token ci.access",
      );
      expect(fake.unhandled).toHaveLength(0);
    });

    it("names who scheduled a canceled send, who moved it, and who canceled it", async () => {
      fake = fakeApi(
        sentSend({
          status: "canceled",
          started_at: null,
          completed_at: 950_000,
          c_delivered: 0,
          c_bounced: 0,
          c_unsent: 0,
          scheduled_by: by({ kind: "human", email: "you@example.com", client: "editor" }),
          rescheduled_by: VIA_CLAUDE,
          canceled_by: by({ kind: "human", email: "you@example.com", client: null }),
        }).routes,
      );
      await mount((r, s) => renderSentRecord("x1", r, s));
      await vi.advanceTimersByTimeAsync(0);
      expect($(".rec-by").textContent).toBe(
        "Scheduled by you@example.com · rescheduled by you@example.com via Claude Code · canceled by you@example.com via the API",
      );
      expect(fake.unhandled).toHaveLength(0);
    });

    it("names who scheduled a send on its watch, and nothing for a send none is recorded on", async () => {
      const watched = sendView(
        send({
          status: "sending",
          completed_at: null,
          scheduled_by: by({ kind: "service", client: null }),
        }),
        { phase: "progressing" },
      );
      fake = fakeApi([
        {
          path: "/api/sends/x1",
          reply: () => ({ send: watched, outcomes: outcomes(), cursor: "1.1" }),
        },
        feedOf(() => watched),
      ]);
      await mount((r, s) => renderSentRecord("x1", r, s));
      await vi.advanceTimersByTimeAsync(0);
      expect($(".watch-card .rec-by").textContent).toBe("Scheduled by a service token");
      unmount();
      fake.restore();

      fake = fakeApi([...sentSend().routes, noRows]);
      await mount((r, s) => renderSentRecord("x1", r, s));
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector(".rec-by")).toBeNull();
      expect(fake.unhandled).toHaveLength(0);
    });
  });

  it("follows receipts past ten minutes with no cap, never re-reading the whole record", async () => {
    const sent = sentSend(SETTLING);
    fake = fakeApi([...sent.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    sent.receipt({ c_accepted: 4, c_complained: 1 }); // a late complaint
    await vi.advanceTimersByTimeAsync(3000);
    expect($(".rec-n.danger").textContent).toBe("1");
    expect(fake.calls.filter((c) => c.url.pathname === "/api/sends/x1")).toHaveLength(1);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("goes back to the watch when a settling send resumes sending", async () => {
    const sent = sentSend(SETTLING);
    fake = fakeApi([...sent.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($(".rec-card")).toBeTruthy();
    // A Resolve that put ambiguous recipients back to be handed off, say.
    sent.receipt({ status: "sending", completed_at: null, c_accepted: 4, c_pending: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($(".watch-card")).toBeTruthy();
    expect(fake.unhandled).toHaveLength(0);
  });

  it("re-reads the page when its send is removed, and stops following", async () => {
    const sent = sentSend(SETTLING);
    fake = fakeApi([...sent.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    sent.remove(); // deleted with its post
    await vi.advanceTimersByTimeAsync(3000);
    expect($("#app .error")).toBeTruthy(); // the re-read finds no send
    const feeds = feedReads(fake).length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(feedReads(fake)).toHaveLength(feeds);
  });

  it("re-reads the page and follows again when its cursor is ahead of the database", async () => {
    const sent = sentSend(SETTLING);
    sent.aheadOnce(); // a local reset
    fake = fakeApi([...sent.routes, noRows]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    const reads = () => fake.calls.filter((c) => c.url.pathname === "/api/sends/x1").length;
    expect(reads()).toBe(2); // its own read, then again after the refused cursor
    sent.receipt({ c_delivered: 6, c_accepted: 4 });
    await vi.advanceTimersByTimeAsync(3000);
    expect($(".rec-n.ok").textContent).toBe("6"); // following again
  });

  it("switches the recipients view and reloads from page one", async () => {
    fake = fakeApi([
      ...sentSend().routes,
      {
        path: "/api/sends/x1/deliveries",
        reply: () => ({ deliveries: [], view: "all", page: { ...page, total: 0 } }),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    $(".rec-view-btn[data-view='all']").click();
    await vi.advanceTimersByTimeAsync(0);
    const last = fake.calls.at(-1);
    expect(last?.url.searchParams.get("view")).toBe("all");
    expect($(".rec-view-btn[data-view='all']").getAttribute("aria-pressed")).toBe("true");
    expect($("#recRows").textContent).toMatch(/No recipients on this send/);
  });

  it("brings a bounce into the failures list when a settling poll moves the counts", async () => {
    let bounced = false;
    const sent = sentSend({ c_delivered: 7, c_bounced: 0, c_unsent: 0, c_accepted: 3 });
    fake = fakeApi([
      ...sent.routes,
      {
        path: "/api/sends/x1/deliveries",
        reply: (req) => {
          const failures = bounced && req.url.searchParams.get("view") === "failures";
          return {
            deliveries: failures ? [rows[0]] : [],
            view: req.url.searchParams.get("view"),
            page: { ...page, total: failures ? 1 : 0 },
          };
        },
      },
    ]);
    const lists = () => fake.calls.filter((c) => c.url.pathname.endsWith("/deliveries"));
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    $(".rec-view-btn[data-view='failures']").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#recRows").textContent).toMatch(/No delivery failures/);
    expect($(".rec-n.warn").textContent).toBe("0");

    bounced = true; // a bounce receipt lands
    sent.receipt({ c_accepted: 2, c_bounced: 1 });
    await vi.advanceTimersByTimeAsync(3000); // the layer's next read while it settles
    expect($(".rec-n.warn").textContent).toBe("1");
    expect($$(".rec-people-table tbody tr")).toHaveLength(1);
    expect($(".rec-people-table .rec-email").textContent).toBe("b@x.y");
    expect($(".rec-people-table .rec-out").textContent).toBe("Hard bounce");
    const reload = lists().at(-1)?.url.searchParams;
    expect(reload?.get("view")).toBe("failures");
    expect(reload?.get("offset")).toBe("0");
    expect(fake.unhandled).toHaveLength(0);
  });

  it("reloads the list only when a poll moves the counts, keeping the reader's view, search, sort, and page", async () => {
    const sent = sentSend(SETTLING);
    fake = fakeApi([
      ...sent.routes,
      {
        path: "/api/sends/x1/deliveries",
        reply: (req) => ({
          deliveries: rows,
          view: req.url.searchParams.get("view"),
          page: { ...page, total: 120, offset: Number(req.url.searchParams.get("offset")) },
        }),
      },
    ]);
    const lists = () => fake.calls.filter((c) => c.url.pathname.endsWith("/deliveries"));
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    $(".rec-view-btn[data-view='all']").click();
    await vi.advanceTimersByTimeAsync(0);
    typeInto($<HTMLInputElement>(".rec-people-search"), "x.y");
    await vi.advanceTimersByTimeAsync(250);
    $<HTMLButtonElement>(".th-sort[data-sort='email']").click(); // email asc → desc
    await vi.advanceTimersByTimeAsync(0);
    $<HTMLButtonElement>(".pager-next").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($(".pager-range").textContent).toBe("51–100 of 120");
    const read = lists().length;

    await vi.advanceTimersByTimeAsync(3000); // nothing new: the reader stays on page two
    expect(lists().length).toBe(read);
    expect($(".pager-range").textContent).toBe("51–100 of 120");

    sent.receipt({ c_delivered: 6, c_accepted: 4 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(lists().length).toBe(read + 1);
    const reload = lists().at(-1)?.url.searchParams;
    expect(reload?.get("view")).toBe("all");
    expect(reload?.get("search")).toBe("x.y");
    expect(reload?.get("sort")).toBe("email");
    expect(reload?.get("dir")).toBe("desc");
    expect(reload?.get("offset")).toBe("50");
    expect($(".pager-range").textContent).toBe("51–100 of 120");
    expect($(".rec-view-btn[data-view='all']").getAttribute("aria-pressed")).toBe("true");
    expect($<HTMLInputElement>(".rec-people-search").value).toBe("x.y");
    expect(fake.unhandled).toHaveLength(0);
  });

  it("lets the reader's own reload win over a poll's that answers later", async () => {
    const sent = sentSend(SETTLING);
    let held: ((v: unknown) => void) | null = null;
    const release = () => held?.(null);
    let allReads = 0;
    fake = fakeApi([
      ...sent.routes,
      {
        path: "/api/sends/x1/deliveries",
        reply: (req) => {
          const view = req.url.searchParams.get("view");
          const answer = { deliveries: view === "all" ? rows : [], view, page };
          // The mount's read of everyone answers at once; the poll's reload is held open.
          return view === "all" && ++allReads === 2
            ? new Promise((r) => (held = r)).then(() => answer)
            : answer;
        },
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    sent.receipt({ c_delivered: 6, c_accepted: 4 });
    await vi.advanceTimersByTimeAsync(3000); // the refresh's reload is now pending
    expect(allReads).toBe(2);
    $(".rec-view-btn[data-view='delivered']").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#recRows").textContent).toMatch(/No delivery receipts confirmed yet/);
    release(); // the stale answer for everyone lands last
    await vi.advanceTimersByTimeAsync(0);
    expect($("#recRows").textContent).toMatch(/No delivery receipts confirmed yet/);
    expect(document.querySelector(".rec-people-table")).toBeNull();
    expect(fake.unhandled).toHaveLength(0);
  });

  // A settling record whose counts move on the second read, and a recipients list the
  // spec answers per request.
  const settlingRecord = (
    deliveries: (req: { url: URL }) => unknown,
  ): { moveCounts: () => void; lists: () => { url: URL }[] } => {
    const sent = sentSend(SETTLING);
    let delivered = SETTLING.c_delivered;
    fake = fakeApi([...sent.routes, { path: "/api/sends/x1/deliveries", reply: deliveries }]);
    return {
      moveCounts: () => {
        delivered += 1;
        sent.receipt({ c_delivered: delivered, c_accepted: 10 - delivered });
      },
      lists: () => fake.calls.filter((c) => c.url.pathname.endsWith("/deliveries")),
    };
  };
  const pageOf = (req: { url: URL }, total: number) => {
    const offset = Number(req.url.searchParams.get("offset"));
    return {
      deliveries: offset < total ? rows : [],
      view: req.url.searchParams.get("view"),
      page: { ...page, total, offset },
    };
  };

  it("moves a reader past the end of a shrunken list to its last page", async () => {
    let total = 120;
    const { moveCounts, lists } = settlingRecord((req) => pageOf(req, total));
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    $<HTMLButtonElement>(".pager-next").click();
    await vi.advanceTimersByTimeAsync(0);
    $<HTMLButtonElement>(".pager-next").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($(".pager-range").textContent).toBe("101–120 of 120");

    total = 60; // the view now holds fewer rows than the reader's page starts at
    moveCounts();
    await vi.advanceTimersByTimeAsync(3000);
    expect(lists().at(-2)?.url.searchParams.get("offset")).toBe("100");
    expect(lists().at(-1)?.url.searchParams.get("offset")).toBe("50");
    expect($(".pager-range").textContent).toBe("51–60 of 60");
    expect(fake.unhandled).toHaveLength(0);
  });

  it("keeps the rows when a refresh's reload fails, and says so only for the reader's own", async () => {
    let failing = false;
    const { moveCounts } = settlingRecord((req) =>
      failing ? jsonResponse({ error: "boom" }, 500) : pageOf(req, 120),
    );
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($$(".rec-people-table tbody tr")).toHaveLength(2);

    failing = true;
    moveCounts();
    await vi.advanceTimersByTimeAsync(3000);
    expect($$(".rec-people-table tbody tr")).toHaveLength(2); // still the reader's rows
    expect(document.querySelector("#recRows .error, #recRows [role='alert']")).toBeNull();

    $<HTMLButtonElement>(".pager-next").click(); // the reader's own load does say it failed
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".rec-people-table")).toBeNull();
    expect($("#recRows").textContent).toMatch(/went wrong on the server/);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("shows the error to a reader whose own load a failing refresh overtook", async () => {
    let held: ((v: unknown) => void) | null = null;
    const release = () => held?.(null);
    let failing = false;
    const { moveCounts } = settlingRecord((req) => {
      if (failing) {
        return jsonResponse({ error: "boom" }, 500);
      }
      // The reader's page-two read is held open, so the refresh overtakes it.
      return req.url.searchParams.get("offset") === "50"
        ? new Promise((r) => (held = r)).then(() => pageOf(req, 120))
        : pageOf(req, 120);
    });
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    $<HTMLButtonElement>(".pager-next").click(); // the reader's load, now pending
    await vi.advanceTimersByTimeAsync(0);
    failing = true;
    moveCounts();
    await vi.advanceTimersByTimeAsync(3000); // the layer's next read while it settles: its reload fails
    expect($("#recRows").textContent).toMatch(/went wrong on the server/);
    release(); // the overtaken answer lands last and paints nothing
    await vi.advanceTimersByTimeAsync(0);
    expect($("#recRows").textContent).toMatch(/went wrong on the server/);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("keeps keyboard focus on the same control across a refresh's repaint", async () => {
    const { moveCounts } = settlingRecord((req) => pageOf(req, 120));
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    $<HTMLButtonElement>(".pager-next").focus();
    moveCounts();
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.activeElement).toBe($(".pager-next"));

    $<HTMLButtonElement>(".th-sort[data-sort='email']").focus();
    moveCounts();
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.activeElement).toBe($(".th-sort[data-sort='email']"));
    expect(fake.unhandled).toHaveLength(0);
  });

  it("hands a scheduled send's page to its editor, in place of its history entry", async () => {
    fake = fakeApi([
      {
        path: "/api/sends/x1",
        reply: () => ({
          send: sendView(send({ status: "scheduled", started_at: null, completed_at: null }), {
            phase: "scheduled",
          }),
          outcomes: outcomes(),
          cursor: "1.1",
        }),
      },
    ]);
    // happy-dom's replace() pushes an entry as assign() does, so the spec asserts the call.
    const replace = vi.spyOn(location, "replace");
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect(replace).toHaveBeenCalledWith("#/edit/p1"); // so Back skips this send URL
    expect(location.hash).toBe("#/edit/p1");
    expect(fake.unhandled).toHaveLength(0);
  });

  /** The feed the watch follows, answering with the send as `current()` has it, every read
   *  a change (a new `rev`), read again in 3 s. */
  const feedOf = (current: () => SendView) => {
    let seq = 1;
    return {
      path: "/api/sends/feed",
      reply: () => {
        seq += 1;
        return {
          now: Date.now(),
          sends: [{ ...current(), rev: seq }],
          removed: [],
          cursor: `${seq}.${Date.now()}`,
          more: false,
          conditions: [],
          read_again_at: Date.now() + 3000,
        };
      },
    };
  };
  it("opens the live watch for a send in flight, follows it through the feed, and flips to the record when it finishes", async () => {
    let status: "sending" | "sent" = "sending";
    const current = () =>
      sendView(
        send({
          status,
          c_pending: 4,
          c_in_flight: 1,
          c_accepted: 5,
          c_delivered: 0,
          c_bounced: 0,
          c_unsent: 0,
          completed_at: null,
        }),
        {
          phase: status === "sent" ? "complete" : "progressing",
        },
      );
    fake = fakeApi([
      {
        path: "/api/sends/x1",
        reply: () => ({ send: current(), outcomes: outcomes({ accepted: 0 }), cursor: "1.1" }),
      },
      feedOf(current),
      {
        path: "/api/sends/x1/deliveries",
        reply: () => ({ deliveries: [], view: "failures", page: { ...page, total: 0 } }),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($(".watch-card")).toBeTruthy();
    expect($(".phase-pill").textContent).toBe("Sending");
    expect($$(".wbar")).toHaveLength(2);
    expect($(".wcounts").textContent).toMatch(/5.*Accepted/);
    // The watch keeps no poll of its own: the layer reads the feed from the page's cursor.
    expect(feedReads(fake)).toHaveLength(1);
    expect(feedReads(fake)[0]?.url.searchParams.get("since")).toBe("1.1");
    await vi.advanceTimersByTimeAsync(3000);
    expect(feedReads(fake)).toHaveLength(2);
    status = "sent";
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".watch-card")).toBeNull();
    expect($(".rec-card")).toBeTruthy(); // the frozen record now
  });

  it("puts the provider's refusal of the account at the top of the watch", async () => {
    const refused = sendView(send({ status: "sending", completed_at: null }), {
      phase: "needs_attention",
      provider: {
        name: "ses",
        halt: {
          reason: "account",
          cause: "credentials",
          error:
            "ses 403 UnrecognizedClientException: The security token included in the request is invalid",
          retries: 1,
          since: 1_000,
          retry_at: Date.now() + 12 * 60_000,
        },
      },
      conditions: [
        condition.refused(
          "ses 403 UnrecognizedClientException: The security token included in the request is invalid",
          Date.now() + 12 * 60_000,
        ),
      ],
    });
    fake = fakeApi([
      {
        path: "/api/sends/x1",
        reply: () => ({ send: refused, outcomes: outcomes({ accepted: 0 }), cursor: "1.1" }),
      },
      feedOf(() => refused),
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($(".phase-pill").textContent).toBe("Needs attention");
    const alert = $("#watchBody .health.red");
    expect(alert.textContent).toContain("The provider is refusing this account");
    expect(alert.textContent).toContain(
      "ses 403 UnrecognizedClientException: The security token included in the request is invalid",
    );
    expect(alert.textContent).toContain(refusalAdvice("credentials"));
    expect(alert.textContent).toContain("ses:SendBulkEmail in its IAM policy");
    expect(document.querySelector("#resolveBtn")).toBeNull(); // Resolve is for a wedge only
    expect($(".wbar-sub").textContent).toMatch(/refusing this account/);
    expect($(".wbar-sub").textContent).toContain("next retry in 12 min");
  });

  // A send held for want of a provider (SPEC §9): the advice's step is the link every
  // not-connected line carries, and the local preview names its restart instead.
  it("advises connecting a provider as a link, or the restart in the local preview", async () => {
    const advice = refusalAdvice("not_connected");
    const held = sendView(send({ status: "sending", completed_at: null }), {
      phase: "needs_attention",
      provider: {
        name: "none",
        halt: {
          reason: "account",
          cause: "not_connected",
          error: "no email provider is connected",
          retries: 1,
          since: 1_000,
          retry_at: null,
        },
      },
      conditions: [
        {
          kind: "refused",
          severity: "action",
          since: 1_000,
          message: `No email provider is connected, so this send is held where it is. ${advice}`,
          action: null,
          cause: "not_connected",
          error: "no email provider is connected",
          advice,
          retry_at: null,
        },
      ],
    });
    for (const [preview, words] of [
      [false, "Connect Amazon SES, then deploy."],
      [true, "Restart npm run dev without SIMULATE_SENDS=not-connected to send."],
    ] as const) {
      const label = preview ? "preview" : "deployed";
      appState.appConfig = settingsResponse({
        deployment: { provider: "none", not_connected_preview: preview },
      });
      fake = fakeApi([
        {
          path: "/api/sends/x1",
          reply: () => ({ send: held, outcomes: outcomes({ accepted: 0 }), cursor: "1.1" }),
        },
        feedOf(() => held),
      ]);
      await mount((r, s) => renderSentRecord("x1", r, s));
      await vi.advanceTimersByTimeAsync(0);
      const alert = $("#watchBody .health.red");
      expect($("strong", alert).textContent).toBe("No email provider is connected");
      expect($(".refused-advice", alert).textContent, label).toBe(words);
      expect(alert.textContent).not.toContain("setup guide");
      const link = alert.querySelector("a");
      expect(link?.getAttribute("href") ?? null, label).toBe(preview ? null : "#/docs/ses");
      unmount();
      fake.restore();
    }
  });

  it("says a post held on another send's halt is waiting and has handed no one off (SPEC §12)", async () => {
    const retryAt = Date.now() + 45 * 60_000;
    const held = sendView(send({ status: "sending", completed_at: null }), {
      phase: "needs_attention",
      audience: { count: 157, fixed: false, fixed_at: null },
      provider: {
        name: "ses",
        halt: {
          reason: "account",
          cause: "quota",
          error: "quota exceeded",
          retries: 6,
          since: 1_000,
          retry_at: retryAt,
        },
      },
      conditions: [condition.refused("quota exceeded", retryAt)],
    });
    fake = fakeApi([
      {
        path: "/api/sends/x1",
        reply: () => ({ send: held, outcomes: outcomes({ accepted: 0 }), cursor: "1.1" }),
      },
      feedOf(() => held),
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($("#watchMeta").textContent).toMatch(
      /^Due .* · held before handing anyone off · about 157 recipients$/,
    );
    expect($(".wbar-sub").textContent).toBe(
      "The provider is refusing this account, so this post waits with the send already held and hasn’t handed anyone off; next retry in 45 min.",
    );
  });

  it("counts a halt's next retry down on the clock while no report arrives", async () => {
    const retryAt = Date.now() + 12 * 60_000;
    const refused = sendView(send({ status: "sending", completed_at: null }), {
      phase: "needs_attention",
      provider: {
        name: "ses",
        halt: {
          reason: "account",
          cause: "quota",
          error: "quota exceeded",
          retries: 1,
          since: 1_000,
          retry_at: retryAt,
        },
      },
      conditions: [condition.refused("quota exceeded", retryAt)],
    });
    fake = fakeApi([
      {
        path: "/api/sends/x1",
        reply: () => ({ send: refused, outcomes: outcomes({ accepted: 0 }), cursor: "1.1" }),
      },
      {
        // Nothing about the send changes: every read reports no send.
        path: "/api/sends/feed",
        reply: () => ({
          now: Date.now(),
          sends: [],
          removed: [],
          cursor: `1.${Date.now()}`,
          more: false,
          conditions: [],
          read_again_at: Date.now() + 60_000,
        }),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($(".wbar-sub").textContent).toContain("next retry in 12 min");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect($(".wbar-sub").textContent).toContain("next retry in 9 min");
  });

  // A send in flight, as the page's read and the feed both report it from `current()`.
  const watching = (current: () => SendView) =>
    fakeApi([
      {
        path: "/api/sends/x1",
        reply: () => ({ send: current(), outcomes: outcomes({ accepted: 0 }), cursor: "1.1" }),
      },
      feedOf(current),
    ]);
  const inFlight = () =>
    send({
      status: "sending",
      c_pending: 4,
      c_accepted: 5,
      c_delivered: 0,
      c_bounced: 0,
      c_unsent: 0,
      completed_at: null,
    });

  it("flags a send in flight too long in amber, in the server's words, until it clears", async () => {
    let stuck = true;
    const current = () =>
      sendView(inFlight(), {
        phase: "progressing",
        conditions: stuck ? [condition.stuck()] : [],
      });
    fake = watching(current);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($("#watchBody .health.amber").textContent).toContain(
      "Nothing has gone out for 31 minutes",
    );
    // The gloss under the bar agrees with the alert rather than saying it is handing off.
    const gloss = () => $$("#watchBody .wbar-sub")[0]?.textContent;
    expect(gloss()).toBe("Nothing is being handed off to the provider right now.");
    stuck = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector("#watchBody .health.amber")).toBeNull();
    expect(gloss()).toBe("Paused between ticks. It resumes on the next sweep.");
    expect(fake.unhandled).toHaveLength(0);
  });

  it("flags a rate limit the deployment causes itself in amber, in the server's words, and an ordinary outage not at all", async () => {
    let selfThrottled = true;
    const current = () =>
      sendView(inFlight(), {
        phase: "backing_off",
        conditions: [condition.unavailable(selfThrottled)],
      });
    fake = watching(current);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($("#watchBody .health.amber").textContent).toContain("SES_MAX_SEND_RATE");
    selfThrottled = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector("#watchBody .health.amber")).toBeNull();
    expect(fake.unhandled).toHaveLength(0);
  });

  it("gives no rate or time to finish while the send is paused, and both while it hands off", async () => {
    let paused = true;
    const current = () =>
      sendView(inFlight(), {
        phase: paused ? "backing_off" : "progressing",
        // The server gives a time to finish only while the send is handing off.
        dispatch: { done: 5, percent: 50, rate_per_min: 30, eta_ms: paused ? null : 120_000 },
      });
    fake = watching(current);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($(".wbar-sub").textContent).not.toMatch(/\/min|ETA/);
    paused = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect($(".wbar-sub").textContent).toMatch(/~30\/min · ETA 2 min/);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("reads a send waiting for its next tick as sending, paused between ticks, not backing off", async () => {
    let between = true;
    const current = () =>
      sendView(send({ ...inFlight(), c_in_flight: between ? 0 : 3 }), {
        phase: "progressing",
        dispatch: { done: 5, percent: 50, rate_per_min: 30, eta_ms: 120_000 },
      });
    fake = watching(current);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect($(".phase-pill").textContent).toBe("Sending");
    expect($(".wbar-sub").textContent).toMatch(
      /^Paused between ticks\. It resumes on the next sweep\. · ~30\/min · ETA 2 min$/,
    );
    between = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect($(".wbar-sub").textContent).toMatch(/^Handing recipients to the provider\./);
    expect(fake.unhandled).toHaveLength(0);
  });

  it("offers Resolve while the server lists it, and names its count", async () => {
    const wedged = sendView(send({ status: "sending", c_in_flight: 2, completed_at: null }), {
      phase: "needs_attention",
      conditions: [condition.wedged(2, "x1")],
      actions: [{ name: "resolve", method: "POST", path: "/api/sends/x1/resolve" }],
    });
    fake = fakeApi([
      {
        path: "/api/sends/x1",
        reply: () => ({ send: wedged, outcomes: outcomes({ accepted: 0 }), cursor: "1.1" }),
      },
      feedOf(() => wedged),
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    $("#resolveBtn").click();
    expect($(".modal h3").textContent).toBe("Resolve 2 ambiguous deliveries");
  });

  it("stops following when the reader navigates away, even with a read in flight", async () => {
    let held: ((v: unknown) => void) | null = null;
    const release = () => held?.(null);
    let reads = 0;
    const view = sendView(send({ status: "sending", completed_at: null }), {
      phase: "progressing",
    });
    const feed = feedOf(() => view);
    fake = fakeApi([
      {
        path: "/api/sends/x1",
        reply: () => ({ send: view, outcomes: outcomes(), cursor: "1.1" }),
      },
      {
        path: "/api/sends/feed",
        // The first read answers at once; the next is held open.
        reply: () =>
          ++reads === 1 ? feed.reply() : new Promise((r) => (held = r)).then(() => feed.reply()),
      },
    ]);
    await mount((r, s) => renderSentRecord("x1", r, s));
    await vi.advanceTimersByTimeAsync(0);
    expect(feedReads(fake)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000); // the next read is now pending
    expect(feedReads(fake)).toHaveLength(2);
    const calls = fake.calls.length;
    unmount(); // what navigating away does: the pending read is cut off with the mount
    release();
    await vi.advanceTimersByTimeAsync(9000);
    // No reschedule, and the cut-off answer reached nothing that would read again (the
    // send's own read, its recipients).
    expect(feedReads(fake)).toHaveLength(2);
    expect(fake.calls).toHaveLength(calls);
  });
});
