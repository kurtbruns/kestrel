import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImportRecord } from "../../shared/imports";
import type { DeliveryRecord } from "../../shared/sends";
import { CAUSE_MEANING, FLAG_MEANING } from "../../shared/subscriber_meanings";
import type { Subscriber, SubscriberDelivery } from "../../shared/subscribers";
import { sendView } from "../test/send_server";
import {
  $,
  $$,
  type FakeApi,
  fakeApi,
  mount,
  resetShell,
  sendSummary,
  settle,
} from "../test/support";
import { fmt } from "../ui/format";
import { renderSubscriber } from "./subscriber";

/** A subscriber as the API answers one: someone who confirmed here, unless `over` says otherwise. */
const subscriber = (over: Partial<Subscriber> = {}): Subscriber => ({
  id: "s1",
  email: "reader@b.c",
  status: "confirmed",
  confirm_token: null,
  confirm_sent_at: 1,
  confirm_attempt_at: 1,
  unsub_token: "u",
  created_at: Date.UTC(2026, 0, 2),
  confirmed_at: Date.UTC(2026, 0, 3),
  unsubscribed_at: null,
  unsubscribe_cause: null,
  origin: "kestrel",
  opt_in: "double",
  consent_evidence: '{"confirmed_ip":"203.0.113.7"}',
  import_id: null,
  suppression: null,
  receives_posts: (over.status ?? "confirmed") === "confirmed" && !over.suppression,
  ...over,
});

/** The address's row on one send. */
function delivered(
  id: string,
  subject: string,
  over: Partial<DeliveryRecord> = {},
): SubscriberDelivery {
  return {
    send: sendView(sendSummary({ id, subject, status: "sent", fire_at: Date.UTC(2026, 1, 1) })),
    delivery: {
      email: "reader@b.c",
      status: "accepted",
      event: "delivered",
      event_detail: null,
      event_at: Date.UTC(2026, 1, 1, 0, 5),
      error: null,
      attempts: 1,
      bounce_kind: null,
      ...over,
    },
  };
}

const record: ImportRecord = {
  id: "imp1",
  created_at: Date.UTC(2026, 0, 2),
  principal: { kind: "human", email: "you@example.com", client: "editor" },
  attestation_version: 2,
  file_name: "sendy.csv",
  file_sha256: "abc",
  plan_hash: "hash",
  counts: {} as ImportRecord["counts"],
  suppressions_added: 0,
};

/** Script the page's reads: the subscriber, their sends a page at a time, and an import. */
function serve(sub: Subscriber, pages: SubscriberDelivery[][] = [[]]): FakeApi {
  return fakeApi([
    { method: "GET", path: `/api/subscribers/${sub.id}`, reply: () => ({ subscriber: sub }) },
    {
      method: "GET",
      path: `/api/subscribers/${sub.id}/deliveries`,
      reply: (req) => {
        const at = Number(req.url.searchParams.get("after") ?? "0");
        return { deliveries: pages[at] ?? [], next: at + 1 < pages.length ? String(at + 1) : null };
      },
    },
    { method: "GET", path: "/api/imports/imp1", reply: () => ({ import: record }) },
  ]);
}

/** A section's rows, label to value. */
function rowsOf(section: string): Record<string, string | null | undefined> {
  const dts = $$(`section[aria-labelledby='${section}'] .sub-dl dt`);
  return Object.fromEntries(dts.map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
}

function sectionTitles(): string[] {
  return $$("section.sub-sec h2").map((h) => h.textContent ?? "");
}

describe("the subscriber page (SPEC §8, DESIGN §3)", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    location.hash = "#/subscribers/s1";
  });
  afterEach(() => fake?.restore());

  it("is titled with the address and its status pill, and shows how they joined here (SPEC §7)", async () => {
    fake = serve(subscriber());
    await mount((r, s) => renderSubscriber("s1", r, s));
    await settle();
    expect($("h1.sub-title").textContent).toBe("reader@b.c");
    expect($(".sub-pills .badge").textContent).toBe("confirmed");
    expect(sectionTitles()).toEqual(["How they joined", "Suppression", "Sends"]);
    const rows = rowsOf("subJoinedTitle");
    expect(rows["How they joined"]).toBe("Double opt-in");
    expect(rows.Joined).toBe(fmt(Date.UTC(2026, 0, 2)));
    expect(rows.Confirmed).toBe(fmt(Date.UTC(2026, 0, 3)));
    expect($(".sub-evidence").textContent).toBe('{\n  "confirmed_ip": "203.0.113.7"\n}');
    expect("Import" in rows).toBe(false);
    expect(document.querySelector(".sub-note")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("names the import that brought them: its file, when, by whom, and the attestation's version (SPEC §7)", async () => {
    fake = serve(subscriber({ origin: "sendy", opt_in: "single", import_id: "imp1" }));
    await mount((r, s) => renderSubscriber("s1", r, s));
    await settle();
    const rows = rowsOf("subJoinedTitle");
    expect(rows["How they joined"]).toBe("Imported · Sendy, single opt-in");
    expect(rows.Origin).toBe("Sendy");
    expect(rows["Opt-in"]).toBe("single opt-in");
    expect(rows.Import).toBe("sendy.csv");
    expect(rows.Imported).toBe(`${fmt(Date.UTC(2026, 0, 2))}, by you@example.com`);
    expect(rows.Attestation).toBe("Version 2");
    expect($(".sub-note").textContent).toBe(
      "The origin, opt-in, confirmation date, and evidence are what the imported file said, not something Kestrel recorded itself.",
    );
    expect(fake.calls.map((c) => c.url.pathname)).toContain("/api/imports/imp1");
    expect(fake.unhandled).toEqual([]);
  });

  it("shows the suppression's flag in the shared words, the provider's detail, and since when (SPEC §7)", async () => {
    const since = Date.UTC(2026, 2, 4);
    fake = serve(
      subscriber({
        suppression: { reason: "import_bounce", detail: "550 no such user", created_at: since },
      }),
    );
    await mount((r, s) => renderSubscriber("s1", r, s));
    await settle();
    expect($(".sub-pills .row-flag").textContent).toBe("bounced");
    const section = $("section[aria-labelledby='subSupTitle']");
    expect($(".sub-sup-line", section).textContent).toBe(`bounced since ${fmt(since)}`);
    expect($(".sub-meaning", section).textContent).toBe(
      "Mail to this address failed at the service your list was imported from. You can clear it.",
    );
    expect(rowsOf("subSupTitle")).toEqual({ Detail: "550 no such user" });
    expect(fake.unhandled).toEqual([]);
  });

  it("says whose the suppression was where the record can tell, and the legend's words where it can't (SPEC §7)", async () => {
    const meaningFor = async (over: Partial<Subscriber>) => {
      fake?.restore();
      fake = serve(subscriber(over));
      await mount((r, s) => renderSubscriber("s1", r, s));
      await settle();
      return $("section[aria-labelledby='subSupTitle'] .sub-meaning").textContent;
    };
    const blocked = { reason: "manual" as const, detail: null, created_at: 1 };
    expect(await meaningFor({ suppression: { ...blocked, reason: "bounce" } })).toBe(
      "Your email provider reported that mail to this address failed. You can clear it.",
    );
    // Joined here, so the block can only be the publisher's.
    expect(await meaningFor({ suppression: blocked })).toBe(
      "You blocked this address. You can unblock it.",
    );
    // Imported, so the block may have come with the file: the record doesn't say.
    expect(await meaningFor({ suppression: blocked, import_id: "imp1", origin: "sendy" })).toBe(
      FLAG_MEANING.blocked,
    );
    expect(fake.unhandled).toEqual([]);
  });

  it("lists each send newest first with its outcome, linking to its record, and pages on request (SPEC §8)", async () => {
    fake = serve(subscriber(), [
      [
        delivered("x2", "Spring", { event: "bounced", bounce_kind: "hard", event_detail: "550" }),
        delivered("x1", "Winter"),
      ],
      [delivered("x0", "Autumn", { status: "skipped", event: null, event_at: null })],
    ]);
    await mount((r, s) => renderSubscriber("s1", r, s));
    await settle();
    const rows = () =>
      $$("#subSends tbody tr").map((tr) => [
        tr.querySelector("a")?.getAttribute("href"),
        tr.querySelector(".rec-out")?.textContent,
        tr.children[2]?.textContent,
      ]);
    expect(rows()).toEqual([
      ["#/sent/x2", "Hard bounce", "550"],
      ["#/sent/x1", "Delivered", "—"],
    ]);
    $(".sub-more").click();
    await settle();
    expect(rows()[2]).toEqual([
      "#/sent/x0",
      "Skipped",
      "Left out: unsubscribed or suppressed before it went",
    ]);
    expect(document.querySelector(".sub-more")).toBeNull();
    expect(
      fake.calls.filter((c) => c.url.pathname.endsWith("/deliveries")).map((c) => c.url.search),
    ).toEqual(["", "?after=1"]);
    expect(fake.unhandled).toEqual([]);
  });

  it("says why someone left in the shared words, and for a complaint which send it was about (SPEC §7)", async () => {
    const left = Date.UTC(2026, 3, 1);
    fake = serve(
      subscriber({ status: "unsubscribed", unsubscribed_at: left, unsubscribe_cause: "complaint" }),
      [[delivered("x2", "Spring", { event: "complained" }), delivered("x1", "Winter")]],
    );
    await mount((r, s) => renderSubscriber("s1", r, s));
    await settle();
    // The head shows the status alone, as the roster does; why is in its own section.
    expect($(".sub-pills").textContent).toBe("unsubscribed");
    const section = $("section[aria-labelledby='subLeftTitle']");
    expect($(".sub-left-line", section).textContent).toBe(`Left ${fmt(left)}`);
    expect($(".sub-meaning", section).textContent).toBe(CAUSE_MEANING.complaint);
    expect($("a", section).getAttribute("href")).toBe("#/sent/x2");
    expect($("a", section).textContent).toBe("Spring");
    expect(fake.unhandled).toEqual([]);
  });

  it("links a complaint's send once a later page brings it (SPEC §7)", async () => {
    fake = serve(
      subscriber({ status: "unsubscribed", unsubscribed_at: 1, unsubscribe_cause: "complaint" }),
      [[delivered("x2", "Spring")], [delivered("x1", "Winter", { event: "complained" })]],
    );
    await mount((r, s) => renderSubscriber("s1", r, s));
    await settle();
    const line = $<HTMLElement>("#subComplaint");
    expect(line.hidden).toBe(true);
    $(".sub-more").click();
    await settle();
    expect(line.hidden).toBe(false);
    expect($("a", line).getAttribute("href")).toBe("#/sent/x1");
    expect(fake.unhandled).toEqual([]);
  });

  it("shows the page without the import's rows when its record can't be read", async () => {
    const sub = subscriber({ origin: "sendy", opt_in: "single", import_id: "gone" });
    fake = fakeApi([
      { method: "GET", path: "/api/subscribers/s1", reply: () => ({ subscriber: sub }) },
      {
        method: "GET",
        path: "/api/subscribers/s1/deliveries",
        reply: () => ({ deliveries: [], next: null }),
      },
      {
        method: "GET",
        path: "/api/imports/gone",
        reply: () =>
          new Response(JSON.stringify({ error: "not_found", message: "Not found: import" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      },
    ]);
    await mount((r, s) => renderSubscriber("s1", r, s));
    await settle();
    const rows = rowsOf("subJoinedTitle");
    expect(rows["How they joined"]).toBe("Imported · Sendy, single opt-in");
    expect("Import" in rows).toBe(false);
    expect(fake.unhandled).toEqual([]);
  });

  it("offers the row menu's acts for who they are, and reads itself again after one lands", async () => {
    let sub = subscriber({ suppression: { reason: "bounce", detail: null, created_at: 1 } });
    fake = fakeApi([
      { method: "GET", path: "/api/subscribers/s1", reply: () => ({ subscriber: sub }) },
      {
        method: "GET",
        path: "/api/subscribers/s1/deliveries",
        reply: () => ({ deliveries: [], next: null }),
      },
      {
        method: "POST",
        path: "/api/suppressions/lift",
        reply: () => {
          sub = { ...sub, suppression: null, receives_posts: true };
          return { email: sub.email, lifted: true };
        },
      },
    ]);
    await mount((r, s) => renderSubscriber("s1", r, s));
    await settle();
    const acts = () => $$<HTMLButtonElement>("[data-act]").map((b) => b.textContent);
    expect(acts()).toEqual(["Unsubscribe…", "Clear…", "Erase…"]);
    $$<HTMLButtonElement>("[data-act]")[1]!.click();
    expect($(".modal h3").textContent).toBe("Clear this bounce?");
    $("#cGo").click();
    await settle();
    expect(acts()).toEqual(["Unsubscribe…", "Block…", "Erase…"]);
    expect($("section[aria-labelledby='subSupTitle'] p").textContent).toBe("None.");
    expect($(".sub-receives").textContent).toBe("Receives your posts.");
    // The Clear… that opened the dialog is gone, so focus goes to the title (DESIGN §11).
    expect(document.activeElement).toBe($("h1.sub-title"));
    expect(fake.unhandled).toEqual([]);
  });

  it("says first whether they receive your posts, and every reason when they don't (SPEC §7)", async () => {
    const left = Date.UTC(2026, 3, 1);
    const cases: [Partial<Subscriber>, string][] = [
      [{}, "Receives your posts."],
      [
        { suppression: { reason: "bounce", detail: null, created_at: 1 } },
        "Not sent your posts: the address bounced.",
      ],
      [{ status: "pending", confirmed_at: null }, "Not sent your posts: they haven’t confirmed."],
      [
        {
          status: "unsubscribed",
          unsubscribed_at: left,
          unsubscribe_cause: "reader",
          suppression: { reason: "manual", detail: null, created_at: 1 },
        },
        `Not sent your posts: they left the list on ${fmt(left)}, and the address is blocked.`,
      ],
    ];
    for (const [over, line] of cases) {
      fake?.restore();
      fake = serve(subscriber(over));
      await mount((r, s) => renderSubscriber("s1", r, s));
      await settle();
      expect($(".sub-receives").textContent).toBe(line);
    }
    expect(fake.unhandled).toEqual([]);
  });

  it("tells someone who signed up again after leaving what happened before, in the past (SPEC §7)", async () => {
    const left = Date.UTC(2026, 3, 1);
    fake = serve(
      subscriber({
        status: "pending",
        confirmed_at: null,
        unsubscribed_at: left,
        unsubscribe_cause: "erased",
      }),
    );
    await mount((r, s) => renderSubscriber("s1", r, s));
    await settle();
    const section = $("section[aria-labelledby='subLeftTitle']");
    expect($("h2", section).textContent).toBe("Left before");
    expect($$(".sub-meaning", section).map((p) => p.textContent)).toEqual([
      "You had erased them at their request.",
      "They signed up again, and haven’t confirmed yet.",
    ]);
    expect(fake.unhandled).toEqual([]);
  });

  it("after Erase shows what is left: the address, erased, and when, with no sends (SPEC §7)", async () => {
    const at = Date.UTC(2026, 4, 1);
    let sub = subscriber();
    let erased = false;
    fake = fakeApi([
      { method: "GET", path: "/api/subscribers/s1", reply: () => ({ subscriber: sub }) },
      {
        method: "GET",
        path: "/api/subscribers/s1/deliveries",
        reply: () => ({ deliveries: erased ? [] : [delivered("x1", "Winter")], next: null }),
      },
      {
        method: "POST",
        path: "/api/subscribers/s1/erase",
        reply: () => {
          erased = true;
          sub = subscriber({
            status: "unsubscribed",
            unsubscribe_cause: "erased",
            unsubscribed_at: at,
            created_at: at,
            confirmed_at: null,
            consent_evidence: null,
            origin: null,
            opt_in: null,
            unsub_token: null,
          });
          return { subscriber: sub, deliveries: 1 };
        },
      },
    ]);
    await mount((r, s) => renderSubscriber("s1", r, s));
    await settle();
    $$<HTMLButtonElement>("[data-act]")
      .find((b) => b.textContent === "Erase…")!
      .click();
    $("#eGo").click();
    await settle();
    expect($("h1.sub-title").textContent).toBe("reader@b.c");
    expect(sectionTitles()).toEqual(["Suppression", "Why they left", "Sends"]);
    expect($(".sub-left-line").textContent).toBe(`Left ${fmt(at)}`);
    expect($(".sub-meaning", $("section[aria-labelledby='subLeftTitle']")).textContent).toBe(
      CAUSE_MEANING.erased,
    );
    expect($("#subSends").textContent).toBe(
      "Their past sends show an erased recipient in place of the address, so none is listed here.",
    );
    // Nothing is left to act on but the address's suppression, so Erase is gone.
    expect($$("[data-act]").map((b) => b.textContent)).toEqual(["Block…"]);
    expect(fake.unhandled).toEqual([]);
  });

  it("an unknown subscriber shows the server's refusal with a way back to the list", async () => {
    fake = fakeApi([
      {
        method: "GET",
        path: /^\/api\/subscribers\/gone/,
        reply: () =>
          new Response(JSON.stringify({ error: "not_found", message: "Not found: subscriber" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      },
    ]);
    await mount((r, s) => renderSubscriber("gone", r, s));
    await settle();
    expect($("a.back").getAttribute("href")).toBe("#/subscribers");
    expect(document.querySelector("h1.sub-title")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });
});
