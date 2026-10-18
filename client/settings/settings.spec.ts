import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse, SettingsView } from "../../shared/settings";
import { appState } from "../state";
import { sendView } from "../test/send_server";
import {
  $,
  $$,
  type FakeApi,
  type FakeRoute,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  sendSummary,
  settingsResponse,
  stubClipboard,
  typeInto,
  unmount,
} from "../test/support";
import { fmt } from "../ui/format";
import { squareImage, UnreadableImage } from "../ui/square_image";
import { renderSettings } from "./settings";

// The browser's canvas, which squares a picked logo, doesn't exist under happy-dom: the
// stand-in answers as `squareImage` would for a source of the given size, and every other
// part of the upload (the upload itself, its toast, the page's update) runs for real.
vi.mock("../ui/square_image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/square_image")>()),
  squareImage: vi.fn(),
}));
const SQUARED_PNG = new Blob(["squared"], { type: "image/png" });
function pickedImage(width: number, height: number) {
  vi.mocked(squareImage).mockResolvedValue({
    png: SQUARED_PNG,
    width,
    height,
  });
}

const DEFAULT_COPY = {
  subject: "Confirm your subscription",
  body: "Click below to confirm.",
  button_label: "Confirm",
  reassurance: "If this wasn't you, ignore this email.",
};

// Deployed on SES, with notifications through it; the template prints the name and logo.
// `settings` merges field by field over this publication; the rest replaces.
const response = (
  over: { settings?: Partial<SettingsView> } & Partial<Omit<SettingsResponse, "settings">> = {},
): SettingsResponse =>
  settingsResponse({
    deployment: {
      provider: "ses",
      from_address: "Birds <hello@send.birds.example>",
      sending_domain: "send.birds.example",
      aws_region: "us-east-1",
      notify_channel: "provider",
      notify_from: "Birds <hello@send.birds.example>",
    },
    in_use: { sends: [], retry_after: null, identity_fields: ["name", "logo_url"] },
    ...over,
    settings: {
      test_recipients: ["me@b.c"],
      publication: { name: "Birds Weekly", tagline: "Owls & more", address: "", logo_url: "" },
      confirmation_email_default: DEFAULT_COPY,
      ...over.settings,
    },
  });

// The settings alone, as a write answers them.
const settings = (over: Partial<SettingsView> = {}): SettingsView =>
  response({ settings: over }).settings;

const bar = () => $("#savebar");

describe("settings view", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
    location.hash = "#/settings";
  });
  afterEach(() => {
    fake?.restore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // The Reader pages section reads the page it shows on every open (reader_pages.spec.ts).
  const readerPage: FakeRoute = {
    path: /^\/api\/reader-pages\//,
    reply: () => new Response("<html><body>page</body></html>"),
  };
  const readerPageReads = () =>
    fake.calls.filter((c) => c.url.pathname.startsWith("/api/reader-pages/")).length;

  async function open(routes: FakeRoute[] = [{ path: "/api/settings", reply: () => response() }]) {
    fake = fakeApi([...routes, readerPage]);
    await mount(renderSettings);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("renders the identity, the sender and instance reflections, the recipients, the subscribe embed, and the confirmation preview", async () => {
    await open();
    expect($<HTMLInputElement>("#setName").value).toBe("Birds Weekly");
    expect(document.querySelector(".set-sub-not-connected")).toBeNull(); // signups are open
    expect($<HTMLInputElement>("#setTagline").value).toBe("Owls & more");
    // Nothing scheduled: the note says where the identity shows up, and no more.
    expect($(".set-note span").textContent).toBe("Shown in every email.");
    // The sender's inbox row, in its read-only card.
    expect($(".set-card.sunken .set-inbox-from").textContent).toBe("Birds");
    expect($(".set-inbox-addr").textContent).toBe("hello@send.birds.example");
    const facts = $$(".set-kv-v").map((v) => v.textContent?.trim());
    expect(facts).toContain("Amazon SES");
    expect(facts).toContain("Local dev token");
    expect(facts).toContain("Not configured");
    expect($(".set-pill").textContent).toBe("default: app origin"); // archive on the app origin
    expect($$(".set-recip-chip").map((c) => c.textContent?.trim())).toEqual(["me@b.c"]);
    expect($(".set-addr").textContent).toBe("https://app.birds.example/subscribe");
    expect($("#embedCode").textContent).toContain(
      `<form action="https://app.birds.example/subscribe" method="post" style=`,
    );
    expect($("#embedPreview .l").textContent).toBe("Subscribe to Birds Weekly");
    // Blank wording previews as the built-in default, so the email is never wordless.
    expect($("#cePvSubject").textContent).toBe(DEFAULT_COPY.subject);
    expect($("#cePvButton").textContent).toBe("Confirm");
    expect($("#cePvFoot").hidden).toBe(true);
    expect($("#cePvMast").hidden).toBe(false);
    expect($("#cePvMastLogo").hidden).toBe(true); // no logo: no monogram either
    expect($("#logoRemove").hidden).toBe(true);
    expect(bar().hidden).toBe(true);
    expect(fake.unhandled).toEqual([]);
  });

  it("orders the sections by whom they serve, editable first and set at deploy last", async () => {
    await open();
    // Each group keeps its sections together, with no heading of its own.
    const groups = $$(".set-group").map((g) => $$(".set-sec-title", g).map((t) => t.textContent));
    expect(groups).toEqual([
      ["Publication identity"],
      ["Ways to subscribe", "Confirmation email", "Reader pages"],
      ["Email template", "Default test recipients"],
      ["Notifications"],
      ["Email sender", "Instance"],
    ]);
    expect($$(".set-sec-title").every((h) => h.tagName === "H2")).toBe(true);
    expect(fake.unhandled).toEqual([]);
  });

  it("shows the template as a sample email, with the way to the Template page", async () => {
    const signed = "<div>{{ .Post.Body }}<p>{{ .Publication.Name }}</p></div>";
    await open([
      { path: "/api/settings", reply: () => response({ settings: { email_template: signed } }) },
    ]);
    const frame = $<HTMLIFrameElement>("#tplPreview");
    frame.dispatchEvent(new Event("load"));
    const sample = () => frame.contentDocument?.querySelector(".kestrel-email")?.textContent;
    expect(sample()).toContain("Birds Weekly");
    // The sample follows the name as it is typed.
    typeInto($<HTMLInputElement>("#setName"), "Owls Monthly");
    expect(sample()).toContain("Owls Monthly");
    $("#tplEditLink").click();
    expect(location.hash).toBe("#/template");
  });

  it("reflects the minimum lead and a local send simulation read-only, as deploy config", async () => {
    const row = (label: string) =>
      $$(".set-kv-k")
        .find((k) => k.textContent === label)
        ?.nextElementSibling?.textContent?.trim();
    await open();
    expect(row("Minimum lead")).toBe("5 minutesdefault");
    expect(row("Email provider")).toBe("Amazon SES");
    unmount();
    fake.restore();
    const local = response();
    local.deployment = {
      ...local.deployment,
      provider: "fake",
      min_lead_ms: 60_000,
      simulation: { profile: "ses", faults: "none" },
    };
    await open([{ path: "/api/settings", reply: () => local }]);
    expect(row("Minimum lead")).toBe("1 minute");
    expect(row("Email provider")).toBe("Fake (dev, dead-end)Simulating Amazon SES, no failures");
  });

  it("says under the From address where readers' replies go, linking the guide step, and never warns", async () => {
    await open();
    const note = $("#replyNote");
    expect(note.closest(".set-kv-v")?.querySelector(".mono")?.textContent).toBe(
      "Birds <hello@send.birds.example>",
    );
    expect(note.textContent).toBe("Readers’ replies go to this address. Forward it to your inbox.");
    expect($<HTMLAnchorElement>("a", note).getAttribute("href")).toBe(
      "#/docs/ses/3-receive-replies-at-your-from-address",
    );
    // An explanation, not a state: the app can't see the forwarding, so nothing reads as a warning.
    expect(note.classList.contains("amber")).toBe(false);
    expect(note.querySelector("svg")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("says no email provider is connected and points to connecting one, on a deployment partway through setup", async () => {
    const notConnected = response();
    notConnected.deployment = { ...notConnected.deployment, provider: "none" };
    await open([{ path: "/api/settings", reply: () => notConnected }]);
    const value = $("#providerValue");
    expect(value.textContent?.trim()).toBe(
      "No email provider connected. Connect Amazon SES to start sending.",
    );
    expect($<HTMLAnchorElement>("a", value).getAttribute("href")).toBe("#/docs/ses");
    // Ways to subscribe keeps the address and the code, and says signups are closed.
    const closed = $(".set-sub-not-connected");
    expect(closed.classList.contains("amber")).toBe(true);
    expect(closed.textContent?.replace("⚠️", "")).toBe(
      "No email provider connected, so signups aren’t open yet: the page below says so, and the form takes no address. Connect Amazon SES to open signups.",
    );
    expect($("#embedCode").textContent).toContain("/subscribe");
    // Notifications would go through that provider, once there is one.
    const sentThrough = $$(".set-kv-k").find((k) => k.textContent === "Sent through");
    expect(sentThrough?.nextElementSibling?.textContent).toBe(
      "Your email provider, once one is connected",
    );
  });

  it("offers the mailing address as an Add row until one is added, with Remove to take it back", async () => {
    await open();
    expect($("#addrAdd").hidden).toBe(false);
    expect($("#addrField").hidden).toBe(true);
    expect($("#addrAdd .field-hint").textContent).toMatch(
      /CAN-SPAM.*A P\.O\. box works\. When to provide a mailing address/,
    );
    // Each place the address shows links the docs section, in a new tab so the form stays.
    for (const where of ["#addrAdd .field-hint", "#addrField .field-hint", "#addrWarn"]) {
      const link = $<HTMLAnchorElement>(`${where} a`);
      expect(link.getAttribute("href"), where).toBe(
        "#/docs/name-your-publication/when-to-provide-a-mailing-address",
      );
      expect(link.target, where).toBe("_blank");
    }
    $("#addrAddBtn").click();
    expect($("#addrAdd").hidden).toBe(true);
    expect($("#addrField").hidden).toBe(false);
    expect(document.activeElement).toBe($("#setAddress"));
    expect($("#addrWarn").hidden).toBe(true); // opened but empty: nothing to warn about
    typeInto($<HTMLInputElement>("#setAddress"), "PO Box 1142");
    expect(bar().classList.contains("show")).toBe(true);
    $("#addrRemove").click();
    expect($<HTMLInputElement>("#setAddress").value).toBe("");
    expect($("#addrAdd").hidden).toBe(false);
    expect($("#addrField").hidden).toBe(true);
    expect(bar().classList.contains("show")).toBe(false); // back to the saved baseline
  });

  it("shows a saved address as the open field, quiet while the template prints it", async () => {
    const pub = { name: "Birds Weekly", tagline: "", address: "PO Box 1142", logo_url: "" };
    await open([
      {
        path: "/api/settings",
        reply: () =>
          response({
            settings: { publication: pub },
            in_use: { sends: [], retry_after: null, identity_fields: ["name", "address"] },
          }),
      },
    ]);
    expect($("#addrAdd").hidden).toBe(true);
    expect($("#addrField").hidden).toBe(false);
    expect($<HTMLInputElement>("#setAddress").value).toBe("PO Box 1142");
    expect($("#addrWarn").hidden).toBe(true);
  });

  it("warns on the address field while the template leaves the address out", async () => {
    // The fixture's template renders the name and logo, not the address.
    await open();
    $("#addrAddBtn").click();
    typeInto($<HTMLInputElement>("#setAddress"), "PO Box 1142");
    expect($("#addrWarn").hidden).toBe(false);
    expect($("#setAddress").getAttribute("aria-describedby")).toBe("addrWarn");
    expect($("#addrWarn").textContent).toBe(
      "Your email template currently doesn’t include this field. If you send promotional email, add it to the template. When to provide a mailing address ↗ (opens in a new tab)",
    );
    typeInto($<HTMLInputElement>("#setAddress"), "");
    expect($("#addrWarn").hidden).toBe(true);
    expect($("#setAddress").hasAttribute("aria-describedby")).toBe(false);
  });

  it("raises the save bar on an edit and drops it on discard, restoring the field", async () => {
    await open();
    typeInto($<HTMLInputElement>("#setName"), "Birds Monthly");
    expect(bar().classList.contains("show")).toBe(true);
    expect($("#embedPreview .l").textContent).toBe("Subscribe to Birds Monthly"); // live
    $("#savebarDiscard").click();
    expect($<HTMLInputElement>("#setName").value).toBe("Birds Weekly");
    expect(bar().classList.contains("show")).toBe(false);
  });

  it("saves the identity, recipients, and wording, adopting the server's normalized result and the sidebar brand", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "PUT",
        path: "/api/settings",
        // The server's own normalizing, which the client leaves to it: the name's inner
        // whitespace collapsed, the tagline cleared, and the recipients in its order.
        reply: () => ({
          settings: settings({
            publication: { name: "Birds Monthly", tagline: "", address: "", logo_url: "" },
            test_recipients: ["new@b.c", "me@b.c"],
            confirmation_email: { ...DEFAULT_COPY, subject: "Please confirm" },
          }),
          warnings: [],
          remade: [],
        }),
      },
    ]);
    typeInto($<HTMLInputElement>("#setName"), "  Birds   Monthly  ");
    typeInto($<HTMLInputElement>("#recipInput"), "New@B.C");
    $("#recipAdd").click();
    $("#ceTabEdit").click();
    typeInto($<HTMLInputElement>("#ceSubject"), "Please confirm");
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.json()).toEqual({
      publication: { name: "Birds   Monthly", tagline: "Owls & more", address: "" },
      test_recipients: ["me@b.c", "new@b.c"],
      confirmation_email: {
        subject: "Please confirm",
        body: "",
        button_label: "",
        reassurance: "",
      },
      notifications: { to: "" },
    });
    // The server's result is the baseline now, wherever it differs from what was sent.
    expect($<HTMLInputElement>("#setName").value).toBe("Birds Monthly");
    expect($<HTMLInputElement>("#setTagline").value).toBe("");
    expect($$(".set-recip-chip").map((c) => c.textContent?.trim())).toEqual(["new@b.c", "me@b.c"]);
    expect($<HTMLInputElement>("#ceMessage").value).toBe(DEFAULT_COPY.body);
    expect($("#brandName").textContent).toBe("Birds Monthly");
    expect(appState.appConfig?.settings.publication.name).toBe("Birds Monthly");
    expect($("#toasts").textContent).toMatch(/Settings saved/);
    expect(bar().classList.contains("show")).toBe(false);
    // The reader page shown re-reads the identity it wears: once on open, once after.
    expect(readerPageReads()).toBe(2);
  });

  it("shows where notifications go, how they are sent, and how the last one went", async () => {
    await open([
      {
        path: "/api/settings",
        reply: () =>
          response({
            settings: { notifications: { to: "me@b.c" } },
            notification_status: {
              last_sent: { kind: "finished", subject: "Gulls", at: 1_800_000_000_000 },
              last_failure: {
                kind: "refused",
                subject: "Terns",
                at: 1_800_000_100_000,
                error: "destination address not verified",
              },
            },
          }),
      },
    ]);
    expect($<HTMLInputElement>("#notifyTo").value).toBe("me@b.c");
    const facts = $$(".set-kv-v").map((v) => v.textContent?.trim());
    expect(facts).toContain("Your email provider (Amazon SES)");
    expect(facts).toContain("Birds <hello@send.birds.example>");
    // A newer failure outranks the last delivery: the channel has stopped working.
    expect($("#notifyStatus .set-pill.danger").textContent).toBe("Not delivered");
    expect($("#notifyStatus").textContent).toMatch(
      /Terns \(provider refusing\): destination address not verified/,
    );
    // On the provider channel, the note says what it cannot carry.
    expect($("#settingsBody").textContent).toMatch(
      /one about the provider refusing your account cannot reach you/,
    );
    expect($<HTMLButtonElement>("#notifyTest").disabled).toBe(false);
    expect(fake.unhandled).toEqual([]);
  });

  it("names a sandbox notice by what it tells of, since it is about no send", async () => {
    await open([
      {
        path: "/api/settings",
        reply: () =>
          response({
            settings: { notifications: { to: "me@b.c" } },
            notification_status: {
              last_sent: { kind: "sandbox", subject: "", at: 1_800_000_000_000 },
              last_failure: null,
            },
          }),
      },
    ]);
    expect($("#notifyStatus").textContent).toMatch(/, signup refused by the SES sandbox$/);
    expect(fake.unhandled).toEqual([]);
  });

  it("saves the notifications address on the save bar, and holds the test until it is saved", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "PUT",
        path: "/api/settings",
        reply: (req) => {
          const body = req.json() as { notifications: { to: string } };
          return {
            settings: settings({ notifications: { to: body.notifications.to } }),
            warnings: [],
            remade: [],
          };
        },
      },
      {
        method: "POST",
        path: "/api/settings/notifications/test",
        reply: () => ({ to: "me@b.c", channel: "provider" }),
      },
    ]);
    const test = $<HTMLButtonElement>("#notifyTest");
    expect(test.disabled).toBe(true);
    expect($("#notifyTestHint").textContent).toBe("Save an address to send a test.");

    typeInto($<HTMLInputElement>("#notifyTo"), " Me@B.C ");
    expect(bar().classList.contains("show")).toBe(true);
    expect(test.disabled).toBe(true);
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    const put = fake.calls.find((c) => c.method === "PUT");
    expect((put!.json() as { notifications: unknown }).notifications).toEqual({ to: "me@b.c" });
    expect(bar().classList.contains("show")).toBe(false);
    expect(test.disabled).toBe(false);

    test.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.some((c) => c.method === "POST")).toBe(true);
    expect($("#toasts").textContent).toMatch(/Test notification sent to me@b.c/);
    // The test is the channel's latest word, so the status line takes it in place.
    expect($("#notifyStatus .set-pill.ok").textContent?.trim()).toBe("Delivered");
    expect($("#notifyStatus").textContent).toMatch(/test notification/);
    expect(fake.unhandled).toEqual([]);
  });

  it("says a failed test notification in its status row only, not in a toast as well", async () => {
    await open([
      {
        path: "/api/settings",
        reply: () => response({ settings: { notifications: { to: "me@b.c" } } }),
      },
      {
        method: "POST",
        path: "/api/settings/notifications/test",
        reply: () =>
          jsonResponse({ error: "notify_failed", message: "The channel refused it." }, 502),
      },
    ]);
    $<HTMLButtonElement>("#notifyTest").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#notifyStatus .set-pill.danger").textContent).toBe("Not delivered");
    expect($("#notifyStatus").textContent).toMatch(/The channel refused it\./);
    expect($("#toasts").textContent).toBe("");
  });

  it("puts the notifications address back on discard", async () => {
    await open([
      {
        path: "/api/settings",
        reply: () => response({ settings: { notifications: { to: "me@b.c" } } }),
      },
    ]);
    typeInto($<HTMLInputElement>("#notifyTo"), "other@b.c");
    expect($("#notifyTestHint").textContent).toBe(
      "Save first: the test goes to the saved address.",
    );
    $("#savebarDiscard").click();
    expect($<HTMLInputElement>("#notifyTo").value).toBe("me@b.c");
    expect($<HTMLButtonElement>("#notifyTest").disabled).toBe(false);
    expect(bar().classList.contains("show")).toBe(false);
  });

  it("asks before a save that re-makes scheduled emails, then retries with the acknowledgement", async () => {
    const sends = [
      sendView(
        sendSummary({ id: "x1", post_id: "p1", subject: "Gulls", fire_at: 1_800_000_000_000 }),
      ),
    ];
    await open([
      {
        path: "/api/settings",
        reply: () => response({ in_use: { sends, retry_after: null, identity_fields: ["name"] } }),
      },
      {
        method: "PUT",
        path: "/api/settings",
        reply: (req) => {
          const body = req.json() as { remake?: string[] };
          if (!body.remake) {
            return jsonResponse({ error: "remake_required", message: "ack", sends }, 409);
          }
          return { settings: settings(), warnings: [], remade: sends };
        },
      },
    ]);
    // The template section carries the in-use chip; the identity section says it in its note.
    expect($$(".set-chip.inuse").map((c) => c.textContent)).toEqual(["In use by 1 scheduled post"]);
    expect($(".set-note span").textContent).toMatch(
      /Saving a change updates 1 scheduled email too; you’ll confirm first\.$/,
    );
    typeInto($<HTMLInputElement>("#setName"), "Renamed");
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($(".modal h3").textContent).toBe("Apply this change to 1 scheduled email?");
    expect($(".remake-list").textContent).toMatch(/Gulls/);
    $("#rmGo").click();
    await vi.advanceTimersByTimeAsync(0);
    const puts = fake.calls
      .filter((c) => c.method === "PUT")
      .map((c) => c.json() as { remake?: string[] });
    expect(puts.map((p) => p.remake)).toEqual([undefined, ["x1"]]);
    expect($("#toasts").textContent).toMatch(/Settings saved and applied to 1 scheduled email/);
  });

  it("says in words, never on the in-use chip, that saving has to wait for a post about to send, until it no longer does (DESIGN §11)", async () => {
    const at = Date.now() + 120_000;
    const sends = [
      sendView(sendSummary({ id: "x1", post_id: "p1", subject: "Gulls", fire_at: at })),
    ];
    await open([
      {
        path: "/api/settings",
        reply: () => response({ in_use: { sends, retry_after: at, identity_fields: ["name"] } }),
      },
    ]);
    const wait = ` A scheduled post sends at ${fmt(at)}. You can save once it has sent.`;
    const chip = $(".set-chip.inuse");
    expect(chip.hasAttribute("title")).toBe(false);
    // The template section's lede, beside the chip, and the identity section's note.
    const templateLede = () => chip.closest(".set-sec")?.querySelector(".set-lede")?.textContent;
    const identityNote = () => $('[data-group="publication"] .set-note > span').textContent;
    const lede =
      "The template controls the look and feel of the emails you send. Edit it on the Template page.";
    const note =
      "Shown in every email. Saving a change updates 1 scheduled email too; you’ll confirm first.";
    expect(templateLede()).toBe(`${lede}${wait}`);
    expect(identityNote()).toBe(`${note}${wait}`);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(templateLede()).toBe(lede);
    expect(identityNote()).toBe(note);
  });

  it("shows a send about to fire as the bar's blocking error, keeping the edits", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "PUT",
        path: "/api/settings",
        reply: () =>
          jsonResponse(
            {
              error: "remake_too_close",
              message: `"Gulls" sends in 3 minutes; try again once it has sent`,
              retry_after: 1,
              sends: [],
            },
            409,
          ),
      },
    ]);
    typeInto($<HTMLInputElement>("#setName"), "Renamed");
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(bar().classList.contains("is-error")).toBe(true);
    expect($(".savebar-msg").textContent).toMatch(/sends in 3 minutes/);
    expect($<HTMLInputElement>("#setName").value).toBe("Renamed");
  });

  it("marks the input a refused save names, and the bar points there", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "PUT",
        path: "/api/settings",
        reply: () =>
          jsonResponse(
            {
              error: "bad_request",
              message:
                "“nope” isn’t a valid email address. Fix it, or clear the field to turn notifications off.",
              field: "notifications.to",
            },
            400,
          ),
      },
    ]);
    typeInto($<HTMLInputElement>("#notifyTo"), "nope");
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    const input = $<HTMLInputElement>("#notifyTo");
    expect(input.classList.contains("is-invalid")).toBe(true);
    expect($("#notifyTo + .field-error").textContent).toContain(
      "“nope” isn’t a valid email address. Fix it, or clear the field to turn notifications off.",
    );
    expect(document.activeElement).toBe(input);
    expect($(".savebar-msg").textContent).toBe("Not saved: fix the field marked above.");
    // Discard puts the field back without editing it, so the mark goes with the edit.
    $("#savebarDiscard").click();
    expect(input.classList.contains("is-invalid")).toBe(false);
    expect(document.querySelector("#notifyTo + .field-error")).toBeNull();
  });

  it("says why any save failed in the bar, not in a toast that would cover it (DESIGN §5)", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "PUT",
        path: "/api/settings",
        reply: () =>
          jsonResponse({ error: "internal_error", message: "Database unavailable" }, 500),
      },
    ]);
    typeInto($<HTMLInputElement>("#setName"), "Renamed");
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(bar().classList.contains("is-error")).toBe(true);
    expect($(".savebar-msg").textContent).toMatch(/Database unavailable/);
    expect($("#toasts").textContent).toBe("");
    expect($<HTMLInputElement>("#setName").value).toBe("Renamed");
  });

  it("refuses a recipient on its field, not in a toast, and clears the reason on edit (DESIGN §5)", async () => {
    await open();
    const input = $<HTMLInputElement>("#recipInput");
    const reason = () => document.querySelector(".set-recip-add .field-error")?.textContent;
    typeInto(input, "nope");
    $("#recipAdd").click();
    expect(reason()).toBe("!That doesn’t look like an email address.");
    expect(input.classList.contains("is-invalid")).toBe(true);
    expect(input.value).toBe("nope"); // kept, to fix in place
    expect(document.activeElement).toBe(input);
    typeInto(input, "ME@b.c");
    expect(reason()).toBeUndefined();
    expect(input.classList.contains("is-invalid")).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(reason()).toBe("!That inbox is already in the list.");
    expect($("#toasts").textContent).toBe("");
    expect($$(".set-recip-chip")).toHaveLength(1);
    expect(bar().classList.contains("show")).toBe(false);
    $(".set-recip-chip [data-rm='0']").click();
    expect($("#recipChips").textContent).toMatch(/No default recipients yet/);
    expect(bar().classList.contains("show")).toBe(true);
  });

  it("edits the confirmation wording with a live preview, and resets to the default", async () => {
    await open();
    $("#ceTabEdit").click();
    expect($("#ceEditBody").hidden).toBe(false);
    expect($("#cePreviewBody").hidden).toBe(true);
    typeInto($<HTMLInputElement>("#ceSubject"), "Welcome <aboard>");
    typeInto($<HTMLInputElement>("#ceFooter"), "Not you? Ignore this.");
    $("#ceToPreview").click();
    expect($("#cePvSubject").textContent).toBe("Welcome <aboard>"); // text, not markup
    expect($("#cePvFoot").hidden).toBe(false);
    expect($("#cePvFoot").textContent).toBe("Not you? Ignore this.");
    $("#ceReset").click();
    expect($<HTMLInputElement>("#ceSubject").value).toBe(DEFAULT_COPY.subject);
    expect($<HTMLInputElement>("#ceFooter").value).toBe(DEFAULT_COPY.reassurance);
  });

  it("opens on the styled embed, copies it, and switches to plain", async () => {
    const writeText = stubClipboard();
    await open();
    // Styled is the default and comes first: it pastes in anywhere looking like the hosted page.
    expect($$("[data-embed]").map((b) => b.dataset.embed)).toEqual(["styled", "plain"]);
    expect($("[data-embed='styled']").getAttribute("aria-pressed")).toBe("true");
    expect($("#embedPreview form").className).toBe("set-pf-styled");
    // Styled wears the hosted page's look: a Georgia headline over a sans body.
    expect($("#embedCode").textContent).toContain(
      `<div style="font:600 22px/1.2 Georgia,'Times New Roman',serif;letter-spacing:-0.01em;margin-bottom:12px">Subscribe to Birds Weekly</div>`,
    );
    // The reader learns what happens next in their own words, as on the hosted page.
    expect($("#embedCode").textContent).toContain(
      "We’ll email you a link to confirm. Unsubscribe anytime.",
    );
    expect($(".set-pf-fine").textContent).toBe(
      "We’ll email you a link to confirm. Unsubscribe anytime.",
    );
    // Either way it posts an email to the public /subscribe, which starts the double opt-in (I1).
    expect($("#embedCode").textContent).toContain('<input type="email" name="email" required');
    // The toggle names the variant; the Copy at the band's foot says which it copies, its
    // name starting with the words it shows so voice control finds it.
    expect($("#embedCopy button").getAttribute("aria-label")).toBe("Copy HTML, Styled form");
    $("#embedCopy button").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Subscribe to Birds Weekly"));
    expect(writeText.mock.calls[0]?.[0]).toContain("style=");
    // It says so where it sits: the check, its word kept, and no toast.
    expect($("#embedCopy button").getAttribute("aria-label")).toBe("Copied");
    expect($("#embedCopy button span").textContent).toBe("Copy HTML");
    expect($("#toasts").textContent).toBe("");
    $("[data-embed='plain']").click();
    expect($("[data-embed='plain']").getAttribute("aria-pressed")).toBe("true");
    expect($("[data-embed='styled']").getAttribute("aria-pressed")).toBe("false");
    expect($("#embedCode").textContent).toContain(
      `<form action="https://app.birds.example/subscribe" method="post">\n`,
    );
    expect($("#embedCode").textContent).not.toContain("style=");
    expect($("#embedCode").textContent).toContain('<input type="email" name="email"');
    expect($("#embedCopy button").getAttribute("aria-label")).toBe("Copy HTML, Plain form");
    // The Copy follows the toggle: it now copies the plain form, not the styled one.
    $("#embedCopy button").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText.mock.calls[1]?.[0]).toBe($("#embedCode").textContent);
    expect(writeText.mock.calls[1]?.[0]).not.toContain("style=");
  });

  it("escapes the publication's name once in the snippet, and copies it exactly", async () => {
    const writeText = stubClipboard();
    const odd = response({
      settings: { publication: { ...settings().publication, name: `Birds & "Bees" <weekly>` } },
    });
    await open([{ path: "/api/settings", reply: () => odd }]);
    const heading = "Subscribe to Birds &amp; &quot;Bees&quot; &lt;weekly&gt;";
    expect($("#embedCode").textContent).toContain(`margin-bottom:12px">${heading}</div>`);
    $("[data-embed='plain']").click();
    expect($("#embedCode").textContent).toContain(`<label>\n    ${heading}\n`);
    $("#embedCopy button").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText.mock.calls[0]?.[0]).toBe($("#embedCode").textContent);
    expect(writeText.mock.calls[0]?.[0]).toContain(heading);
  });

  it("offers the two ways as parallel bands of one card, the page first, each saying what it is", async () => {
    await open();
    const ways = $$(".set-sec-subscribe .set-card > .set-way");
    expect(ways.map((w) => $(".set-way-title", w).textContent?.trim())).toEqual([
      "Share the page",
      "Embed a form",
    ]);
    expect(ways.map((w) => $(".set-way-line", w).textContent)).toEqual([
      "A public page with your publication’s name and a sign-up form ready to go.",
      "Put a sign-up form on another site you own.",
    ]);
    // The address is a value beside its Copy and Open, not a field.
    const addr = $(".set-way-addr", ways[0]);
    expect($(".copy-btn", addr).dataset.copy).toBe("https://app.birds.example/subscribe");
    expect($<HTMLAnchorElement>("a", addr).href).toBe("https://app.birds.example/subscribe");
    // The toggle sits at the right end of the embed's head, right above the form and code it
    // switches, and "Plain" is said once.
    const head = $(".set-way-head", ways[1]);
    expect(head.lastElementChild?.classList.contains("set-wtog")).toBe(true);
    expect(head.nextElementSibling?.classList.contains("set-embed")).toBe(true);
    expect($(".set-way-head", ways[0]).querySelector(".set-wtog")).toBeNull();
    expect(ways[1]?.textContent?.match(/Plain/g)).toHaveLength(1);
    // The band ends in its one act: Copy HTML, a Secondary button, after the form and code.
    const copy = $<HTMLButtonElement>("#embedCopy button", ways[1]);
    expect(copy.classList.contains("secondary")).toBe(true);
    expect($("span", copy).textContent).toBe("Copy HTML");
    expect($(".set-embed", ways[1]).nextElementSibling?.id).toBe("embedCopy");
  });

  it("previews the plain form as its markup renders, the field inside its label", async () => {
    await open();
    $("[data-embed='plain']").click();
    // The snippet wraps the field in its label and leaves the button beside it, so the
    // preview does too, rather than stacking them like the admin's own fields.
    expect($("#embedCode").textContent).toContain(
      "<label>\n    Subscribe to Birds Weekly\n    <input",
    );
    const form = $("#embedPreview form.set-pf-plain");
    expect($$("input", $("label", form))).toHaveLength(1);
    expect(form.lastElementChild?.tagName).toBe("BUTTON");
  });

  it("names the publication in the page's line only while it has a name, live", async () => {
    await open();
    typeInto($<HTMLInputElement>("#setName"), "");
    // The sender's display name stands in, so the page still has a name.
    expect($("#subscribePageLine").textContent).toContain("your publication’s name");
    const unnamed = response({
      settings: { publication: { ...settings().publication, name: "" } },
    });
    unnamed.deployment.from_address = "hello@send.birds.example";
    unmount();
    await open([{ path: "/api/settings", reply: () => unnamed }]);
    expect($("#subscribePageLine").textContent).toBe(
      "A public page with a sign-up form ready to go.",
    );
    typeInto($<HTMLInputElement>("#setName"), "Owls Monthly");
    expect($("#subscribePageLine").textContent).toContain("your publication’s name");
  });

  it("keeps the embed's Copy as it is while other fields change, and rebuilds it for the name", async () => {
    stubClipboard();
    await open();
    $("#embedCopy button").click();
    await vi.advanceTimersByTimeAsync(0);
    typeInto($<HTMLInputElement>("#notifyTo"), "me@example.com");
    // The snippet doesn't show the notifications address, so its block is left alone.
    expect($("#embedCopy button").getAttribute("aria-label")).toBe("Copied");
    typeInto($<HTMLInputElement>("#setName"), "Owls Monthly");
    expect($("#embedCode").textContent).toContain("Subscribe to Owls Monthly");
  });

  it("offers an embed that reads whole when the publication has no name (SPEC §9)", async () => {
    const writeText = stubClipboard();
    const unnamed = response({
      settings: { publication: { ...settings().publication, name: "" } },
    });
    unnamed.deployment.from_address = "hello@send.birds.example";
    await open([{ path: "/api/settings", reply: () => unnamed }]);
    expect($("#embedPreview .l").textContent).toBe("Subscribe");
    expect($("#embedCode").textContent).toContain('margin-bottom:12px">Subscribe</div>');
    expect($("#embedCode").textContent).not.toContain("Subscribe to");
    $("[data-embed='plain']").click();
    expect($("#embedPreview label").textContent?.trim()).toBe("Subscribe");
    expect($("#embedCode").textContent).toContain("\n    Subscribe\n");
    $("[data-embed='styled']").click();
    expect($("#setName").nextElementSibling?.textContent).toBe(
      "Blank leaves the publication unnamed, since the email “From” has no name.",
    );
    $("#embedCopy button").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText.mock.calls[0]?.[0]).not.toContain("Your publication");
  });

  it("uploads a logo at once, and removes it", async () => {
    const withLogo = settings({
      publication: {
        name: "Birds Weekly",
        tagline: "",
        address: "",
        logo_url: "https://app.birds.example/media/branding/logo?v=1",
      },
    });
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "POST",
        path: "/api/settings/logo",
        reply: () => ({ settings: withLogo, remade: [] }),
      },
      {
        method: "DELETE",
        path: "/api/settings/logo",
        reply: () => ({ settings: settings(), remade: [] }),
      },
    ]);
    const input = $<HTMLInputElement>("#logoInput");
    Object.defineProperty(input, "files", {
      value: [new File(["png"], "logo.png", { type: "image/png" })],
      configurable: true,
    });
    pickedImage(512, 512);
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fake.calls.some((c) => c.method === "POST" && c.url.pathname === "/api/settings/logo"),
    ).toBe(true);
    expect($("#logoTile").classList.contains("has-img")).toBe(true);
    expect($("#logoTile").style.backgroundImage).toContain("branding/logo?v=1");
    expect($("#logoRemove").hidden).toBe(false);
    expect($("#toasts").textContent).toMatch(/Logo updated/);
    // Every surface that renders the logo moves at once, the confirmation email's
    // masthead included — no second edit needed to bring it along.
    expect($("#cePvMastLogo img").getAttribute("src")).toContain("branding/logo?v=1");
    $("#logoRemove").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#logoTile").classList.contains("has-img")).toBe(false);
    expect($("#logoRemove").hidden).toBe(true);
    // …and drops it from the masthead at once too: the cell goes, the way the email's
    // masthead omits it when there is no logo (src/emails/system.ts).
    expect($("#cePvMastLogo").hidden).toBe(true);
    expect($("#toasts").textContent).toMatch(/Logo removed/);
    expect(bar().classList.contains("show")).toBe(false); // the logo never dirties the bar
  });

  // The logo picker, with a file chosen as the browser hands one over.
  const pickLogo = () => {
    const input = $<HTMLInputElement>("#logoInput");
    Object.defineProperty(input, "files", {
      value: [new File(["photo"], "photo.jpg", { type: "image/jpeg" })],
      configurable: true,
    });
    input.dispatchEvent(new Event("change"));
  };
  const logoPosts = () =>
    fake.calls.filter((c) => c.method === "POST" && c.url.pathname === "/api/settings/logo");

  it("uploads a picked logo squared, and says when it was cropped to its center", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "POST",
        path: "/api/settings/logo",
        reply: () => ({ settings: settings(), remade: [] }),
      },
    ]);
    pickedImage(800, 600);
    pickLogo();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(squareImage).mock.calls[0]?.[1]).toBe(256);
    const sent = logoPosts()[0]?.form?.get("file");
    expect(sent instanceof File && [sent.name, sent.type, sent.size]).toEqual([
      "logo.png",
      "image/png",
      SQUARED_PNG.size,
    ]);
    expect(document.querySelector(".modal")).toBeNull(); // no step between the pick and the save
    expect($("#toasts").textContent).toBe("Logo updated, cropped to its center square");
  });

  it("says so when a picked file can't be read as an image", async () => {
    await open();
    vi.mocked(squareImage).mockRejectedValue(new UnreadableImage());
    pickLogo();
    await vi.advanceTimersByTimeAsync(0);
    // Under the tile, the logo's own error home, since it has no save bar.
    expect($("#logoError").hidden).toBe(false);
    expect($("#logoError").textContent).toContain(
      "Couldn’t read that image. Pick a PNG, JPEG, WebP, or GIF.",
    );
    expect($("#toasts").textContent).toBe("");
    expect(logoPosts()).toHaveLength(0);
  });

  it("notes that a logo uploaded before the crop step isn't square, since emails stretch it, until a square one replaces it", async () => {
    // The page reads the current logo as any <img> does; a stand-in reports its size.
    const sizes: Record<string, [number, number]> = {
      "https://app.birds.example/media/branding/logo?v=1": [300, 100],
    };
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 0;
        naturalHeight = 0;
        onload: (() => void) | null = null;
        set src(url: string) {
          [this.naturalWidth, this.naturalHeight] = sizes[url] ?? [256, 256];
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const pub = { name: "Birds Weekly", tagline: "", address: "" };
    const withLogo = (logo_url: string) =>
      response({ settings: { publication: { ...pub, logo_url } } });
    await open([
      {
        path: "/api/settings",
        reply: () => withLogo("https://app.birds.example/media/branding/logo?v=1"),
      },
      {
        method: "POST",
        path: "/api/settings/logo",
        reply: () => ({
          settings: withLogo("https://app.birds.example/media/branding/logo/2-squared").settings,
          remade: [],
        }),
      },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect($("#logoShape").hidden).toBe(false);
    pickedImage(512, 512);
    pickLogo();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#logoShape").hidden).toBe(true); // the square that replaced it
  });

  it("shows the error with a retry", async () => {
    let failures = 1;
    await open([
      {
        path: "/api/settings",
        reply: () => (failures-- > 0 ? jsonResponse({ error: "down" }, 500) : response()),
      },
    ]);
    expect($("#settingsBody .error").textContent).toMatch(/went wrong on the server/);
    $("[data-retry]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($<HTMLInputElement>("#setName").value).toBe("Birds Weekly");
  });
});
