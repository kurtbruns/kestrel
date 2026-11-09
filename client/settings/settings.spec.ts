import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_SECTIONS,
  type SettingsResponse,
  type SettingsView,
  settingsSectionTitled,
} from "../../shared/settings";
import { mounted } from "../lifecycle";
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
  providerStatus,
  resetShell,
  sendSummary,
  settingsResponse,
  stubClipboard,
  stubResizeObserver,
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
      notify_from: "Birds Weekly via Kestrel <hello@send.birds.example>",
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

  // On SES, the provider's connection is read beside the settings: not answered yet, unless a
  // spec's own route says otherwise.
  async function open(routes: FakeRoute[] = [{ path: "/api/settings", reply: () => response() }]) {
    fake = fakeApi([
      ...routes,
      readerPage,
      { path: "/api/provider", reply: () => providerStatus() },
    ]);
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
    const groups = $$(".set-group").map((g) =>
      $$(".set-sec-title", g).map((t) => t.textContent?.trim()),
    );
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
      simulation: { profile: "ses", faults: "none", account: null, refuse: null },
    };
    fake = fakeApi([
      { path: "/api/settings", reply: () => local },
      readerPage,
      // The server's answer for a simulation with no account to stand in for.
      {
        path: "/api/provider",
        reply: () =>
          providerStatus({ provider: "fake", state: "unknown", unknown_reason: "stand_in" }),
      },
    ]);
    await mount(renderSettings);
    await vi.advanceTimersByTimeAsync(0);
    expect(row("Minimum lead")).toBe("1 minute");
    expect(row("Email provider")).toBe("Fake (dev, dead-end)Simulating Amazon SES, no failures");
  });

  it("says under the From address where readers' replies go, linking the guide step, and never warns", async () => {
    await open();
    const note = $("#replyNote");
    expect(note.closest(".set-kv-v")?.querySelector(".mono")?.textContent).toBe(
      "hello@send.birds.example",
    );
    expect(note.textContent).toBe("Readers’ replies go to this address. Forward it to your inbox.");
    expect($<HTMLAnchorElement>("a", note).getAttribute("href")).toBe(
      "#/docs/ses/8-receive-replies-at-your-from-address",
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
      notifications: { to: [] },
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
            settings: { notifications: { to: ["me@b.c"] } },
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
    expect($$("#notifyChips .set-recip-chip").map((c) => c.textContent?.trim())).toEqual([
      "me@b.c",
    ]);
    const facts = $$(".set-kv-v").map((v) => v.textContent?.trim());
    expect(facts).toContain("Your email provider (Amazon SES)");
    expect(facts).toContain("Birds Weekly via Kestrel <hello@send.birds.example>");
    // A newer failure outranks the last delivery: the channel has stopped working.
    expect($("#notifyStatus .set-pill.danger").textContent).toBe("Not delivered");
    expect($("#notifyStatus").textContent).toMatch(
      /Terns \(provider refusing\): destination address not verified/,
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
            settings: { notifications: { to: ["me@b.c"] } },
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

  it("saves the notifications addresses added as chips on the save bar, and holds the test until they are saved", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "PUT",
        path: "/api/settings",
        reply: (req) => {
          const body = req.json() as { notifications: { to: string[] } };
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
        reply: () => ({ to: ["me@b.c", "ops@b.c"], failed: [] }),
      },
    ]);
    const test = $<HTMLButtonElement>("#notifyTest");
    expect(test.disabled).toBe(true);
    expect($("#notifyTestHint").textContent).toBe("Save an address to send a test.");

    expect($("#notifyChips").textContent).toMatch(/No addresses yet/);
    typeInto($<HTMLInputElement>("#notifyTo"), " Me@B.C ");
    $("#notifyAdd").click();
    typeInto($<HTMLInputElement>("#notifyTo"), "ops@b.c");
    $("#notifyAdd").click();
    expect($$("#notifyChips .set-recip-chip").map((c) => c.textContent?.trim())).toEqual([
      "me@b.c",
      "ops@b.c",
    ]);
    expect(bar().classList.contains("show")).toBe(true);
    expect(test.disabled).toBe(true);
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    const put = fake.calls.find((c) => c.method === "PUT");
    expect((put!.json() as { notifications: unknown }).notifications).toEqual({
      to: ["me@b.c", "ops@b.c"],
    });
    expect(bar().classList.contains("show")).toBe(false);
    expect(test.disabled).toBe(false);

    test.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.some((c) => c.method === "POST")).toBe(true);
    expect($("#toasts").textContent).toMatch(/Test notification sent to me@b.c, ops@b.c/);
    // The test is the channel's latest word, so the status line takes it in place.
    expect($("#notifyStatus .set-pill.ok").textContent?.trim()).toBe("Delivered");
    expect($("#notifyStatus").textContent).toMatch(/test notification/);
    expect(fake.unhandled).toEqual([]);
  });

  it("shows notifications as Kestrel on the saved publication's behalf, following a rename once saved, never the From override (SPEC §8)", async () => {
    const named = response();
    named.deployment.from_address = "Field Desk <hello@send.birds.example>";
    await open([
      { path: "/api/settings", reply: () => named },
      {
        method: "PUT",
        path: "/api/settings",
        reply: () => ({
          settings: settings({
            publication: {
              name: "Owls Monthly",
              tagline: "Owls & more",
              address: "",
              logo_url: "",
            },
          }),
          warnings: [],
          remade: [],
        }),
      },
    ]);
    const from = () => $("#notifyFrom").textContent;
    expect(from()).toBe("Birds Weekly via Kestrel <hello@send.birds.example>");
    // Typing alone doesn't change it: a notification goes out with the saved name.
    typeInto($<HTMLInputElement>("#setName"), "Owls Monthly");
    expect(from()).toBe("Birds Weekly via Kestrel <hello@send.birds.example>");
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(from()).toBe("Owls Monthly via Kestrel <hello@send.birds.example>");
    expect(fake.unhandled).toEqual([]);
  });

  it("says these emails can't report SES refusing, linking the alerts section of Verify, and logs a test alert on request (SPEC §12)", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "POST",
        path: "/api/settings/notifications/alert-test",
        reply: () => ({ event: "alert.sending", cause: "test", at: Date.now() }),
      },
    ]);
    const note = $("#alertsNote");
    expect(note.textContent).toMatch(/can’t tell you when SES refuses your account/);
    expect($<HTMLAnchorElement>("a", note).getAttribute("href")).toBe(
      "#/docs/verify/8-create-the-cloudflare-alerts",
    );
    expect(note.textContent?.trim()).toBe(
      "These emails travel through Amazon SES like the newsletter, so they can’t tell you when SES refuses your account. Two Cloudflare alerts cover that, and Kestrel itself stopping. See Create the Cloudflare alerts.",
    );
    $<HTMLButtonElement>("#alertTest").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fake.calls.filter((c) => c.url.pathname === "/api/settings/notifications/alert-test"),
    ).toHaveLength(1);
    expect($("#alertTestHint").textContent).toMatch(
      /^Logged at .+\. Watch for Cloudflare’s alert email\.$/,
    );
    expect(fake.unhandled).toEqual([]);
  });

  it("names the email provider in the alerts note as the Sent through row does, when it isn't SES", async () => {
    const none = response();
    none.deployment.provider = "none";
    await open([{ path: "/api/settings", reply: () => none }]);
    expect($$(".set-kv-v").map((v) => v.textContent?.trim())).toContain(
      "Your email provider, once one is connected",
    );
    expect($("#alertsNote").textContent?.trim()).toBe(
      "These emails travel through your email provider like the newsletter, so they can’t tell you when it refuses your account. Two Cloudflare alerts cover that, and Kestrel itself stopping. See Create the Cloudflare alerts.",
    );
    expect(fake.unhandled).toEqual([]);
  });

  it("says a failed test notification in its status row only, not in a toast as well", async () => {
    await open([
      {
        path: "/api/settings",
        reply: () => response({ settings: { notifications: { to: ["me@b.c"] } } }),
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

  it("names the address a test notification missed, while the others got it", async () => {
    await open([
      {
        path: "/api/settings",
        reply: () => response({ settings: { notifications: { to: ["me@b.c", "ops@b.c"] } } }),
      },
      {
        method: "POST",
        path: "/api/settings/notifications/test",
        reply: () => ({
          to: ["me@b.c", "ops@b.c"],
          failed: [{ email: "ops@b.c", error: "destination address not verified" }],
        }),
      },
    ]);
    $<HTMLButtonElement>("#notifyTest").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#toasts").textContent).toMatch(/Test notification sent to me@b.c$/);
    expect($("#notifyStatus .set-pill.danger").textContent).toBe("Not delivered");
    expect($("#notifyStatus").textContent).toMatch(
      /test notification: ops@b.c: destination address not verified/,
    );
    expect(fake.unhandled).toEqual([]);
  });

  it("checks a notifications address as it is added, and stops at the most it takes", async () => {
    await open([
      {
        path: "/api/settings",
        reply: () =>
          response({
            settings: {
              notifications: { to: ["a@b.c", "b@b.c", "c@b.c", "d@b.c", "e@b.c"] },
            },
          }),
      },
    ]);
    const input = $<HTMLInputElement>("#notifyTo");
    const reason = () => document.querySelector("#notifyTo + .field-error")?.textContent;
    typeInto(input, "f@b.c");
    $("#notifyAdd").click();
    expect(reason()).toContain(
      "Notifications go to at most 5 addresses. Remove one to add another.",
    );
    expect(input.value).toBe("f@b.c");
    $("#notifyChips [data-rm='0']").click();
    typeInto(input, "nope");
    $("#notifyAdd").click();
    expect(reason()).toContain("That doesn’t look like an email address.");
    typeInto(input, "f@b.c");
    $("#notifyAdd").click();
    expect($$("#notifyChips .set-recip-chip").map((c) => c.textContent?.trim())).toEqual([
      "b@b.c",
      "c@b.c",
      "d@b.c",
      "e@b.c",
      "f@b.c",
    ]);
    expect(bar().classList.contains("show")).toBe(true);
  });

  it("puts the notifications address back on discard", async () => {
    await open([
      {
        path: "/api/settings",
        reply: () => response({ settings: { notifications: { to: ["me@b.c"] } } }),
      },
    ]);
    typeInto($<HTMLInputElement>("#notifyTo"), "other@b.c");
    $("#notifyAdd").click();
    expect($("#notifyTestHint").textContent).toBe(
      "Save first: the test goes to the saved addresses.",
    );
    $("#savebarDiscard").click();
    expect($$("#notifyChips .set-recip-chip").map((c) => c.textContent?.trim())).toEqual([
      "me@b.c",
    ]);
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
              message: "Notifications can go to at most 5 addresses. Remove some, then save.",
              field: "notifications.to",
            },
            400,
          ),
      },
    ]);
    typeInto($<HTMLInputElement>("#notifyTo"), "me@b.c");
    $("#notifyAdd").click();
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    const input = $<HTMLInputElement>("#notifyTo");
    expect(input.classList.contains("is-invalid")).toBe(true);
    expect($("#notifyTo + .field-error").textContent).toContain(
      "Notifications can go to at most 5 addresses. Remove some, then save.",
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
    expect($("#subscribePageLine").textContent).toContain("your publication’s name");
    // The sending address's name ("Birds") never stands in (SPEC §9).
    typeInto($<HTMLInputElement>("#setName"), "");
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
    $("#notifyAdd").click();
    // The snippet doesn't show the notifications address, so its block is left alone.
    expect($("#embedCopy button").getAttribute("aria-label")).toBe("Copied");
    typeInto($<HTMLInputElement>("#setName"), "Owls Monthly");
    expect($("#embedCode").textContent).toContain("Subscribe to Owls Monthly");
  });

  it("shows the sender as readers see it: the publication's name over a bare address, following the name as it's typed (SPEC §9)", async () => {
    const bare = response();
    bare.deployment.from_address = "hello@send.birds.example";
    await open([{ path: "/api/settings", reply: () => bare }]);
    const from = () => $(".set-card.sunken .set-inbox-from").textContent;
    const avatar = () => $("#senderAvatar").textContent;
    expect(from()).toBe("Birds Weekly");
    expect(avatar()).toBe("B");
    expect($(".set-inbox-addr").textContent).toBe("hello@send.birds.example");
    // The card says where each half comes from, linking the section that sets the name.
    const note = $(".set-card.sunken .set-ro-note span");
    expect(note.textContent).toBe(
      "The name is your publication’s, from Publication identity. The address is set at deploy in wrangler.jsonc, with the AWS keys stored as secrets, so it can’t be edited here. Change it in the setup guide, then redeploy. Credentials are never shown.",
    );
    expect($<HTMLAnchorElement>("a", note).getAttribute("href")).toBe(
      "#/settings/publication-identity",
    );
    expect($("#setName").nextElementSibling?.textContent).toBe(
      "Also the name your emails come from. Blank sends them with no name.",
    );
    // The inbox rows follow the name live, the confirmation email's too.
    typeInto($<HTMLInputElement>("#setName"), "Owls Monthly");
    expect(from()).toBe("Owls Monthly");
    expect(avatar()).toBe("O");
    expect($("#cePvFrom").textContent).toBe("Owls Monthly");
    // With no name, a reader's inbox shows the address.
    typeInto($<HTMLInputElement>("#setName"), "");
    expect(from()).toBe("hello@send.birds.example");
    expect(avatar()).toBe("H");
    expect($("#cePvFrom").textContent).toBe("hello@send.birds.example");
    expect(fake.unhandled).toEqual([]);
  });

  it("shows a name written into the From address as the sender, whatever the publication is called, and says it's set at deploy (SPEC §9)", async () => {
    await open(); // "Birds <hello@send.birds.example>"
    const from = () => $(".set-card.sunken .set-inbox-from").textContent;
    expect(from()).toBe("Birds");
    expect($(".set-inbox-addr").textContent).toBe("hello@send.birds.example");
    expect($(".set-card.sunken .set-ro-note span").textContent).toBe(
      "The address, and the name “Birds” written in with it, are set at deploy in wrangler.jsonc, with the AWS keys stored as secrets, so neither can be edited here. To send under your publication’s name instead, leave the name out of the address (the setup guide shows how), then redeploy. Credentials are never shown.",
    );
    expect($("#setName").nextElementSibling?.textContent).toBe(
      "Your emails come from “Birds”, a name set at deploy, whatever you put here.",
    );
    typeInto($<HTMLInputElement>("#setName"), "Owls Monthly");
    expect(from()).toBe("Birds");
    expect($("#cePvFrom").textContent).toBe("Birds");
    // The identity still reaches the email through the template, so the note holds.
    expect($('[data-group="publication"] .set-note > span').textContent).toBe(
      "Shown in every email.",
    );
    expect(fake.unhandled).toEqual([]);
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
      "Also the name your emails come from. Blank sends them with no name.",
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

  // A drag event as the browser fires it: `types` says a file is being carried from the
  // moment it enters, while `files` can only be read on the drop.
  const drag = (
    type: "dragover" | "dragleave" | "drop",
    on: HTMLElement,
    {
      files = [],
      types = ["Files"],
      relatedTarget = null,
    }: { files?: File[]; types?: string[]; relatedTarget?: EventTarget | null } = {},
  ) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(e, {
      dataTransfer: { value: { types, files, dropEffect: "none" } },
      relatedTarget: { value: relatedTarget },
    });
    on.dispatchEvent(e);
    return e;
  };
  const dropTargetShows = () => $("#logoTile").classList.contains("dragover");
  const logoWrite: FakeRoute = {
    method: "POST",
    path: "/api/settings/logo",
    reply: () => ({ settings: settings(), remade: [] }),
  };

  it("uploads a logo dropped on the tile just as a picked one, squared", async () => {
    await open([{ path: "/api/settings", reply: () => response() }, logoWrite]);
    pickedImage(800, 600);
    const dropped = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    const e = drag("drop", $("#logoTile"), { files: [dropped] });
    await vi.advanceTimersByTimeAsync(0);
    expect(e.defaultPrevented).toBe(true); // the browser doesn't open the file instead
    expect(vi.mocked(squareImage).mock.lastCall).toEqual([dropped, 256]);
    const sent = logoPosts()[0]?.form?.get("file");
    expect(sent instanceof File && [sent.name, sent.type, sent.size]).toEqual([
      "logo.png",
      "image/png",
      SQUARED_PNG.size,
    ]);
    expect($("#toasts").textContent).toBe("Logo updated, cropped to its center square");
    expect(fake.unhandled).toEqual([]);
  });

  it("takes a drop anywhere on the logo field, not only on the tile", async () => {
    await open([{ path: "/api/settings", reply: () => response() }, logoWrite]);
    pickedImage(512, 512);
    drag("drop", $("#logoReplace"), {
      files: [new File(["png"], "logo.png", { type: "image/png" })],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(logoPosts()).toHaveLength(1);
  });

  it("refuses a dropped non-image with the picker's message, under the tile", async () => {
    await open();
    vi.mocked(squareImage).mockRejectedValue(new UnreadableImage());
    drag("drop", $("#logoTile"), {
      files: [new File(["%PDF"], "notes.pdf", { type: "application/pdf" })],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect($("#logoError").hidden).toBe(false);
    expect($("#logoError").textContent).toContain(
      "Couldn’t read that image. Pick a PNG, JPEG, WebP, or GIF.",
    );
    expect(logoPosts()).toHaveLength(0);
  });

  it("refuses a drop of several files rather than choosing one, and clears that on the next try", async () => {
    await open([{ path: "/api/settings", reply: () => response() }, logoWrite]);
    pickedImage(512, 512);
    vi.mocked(squareImage).mockClear();
    const png = (name: string) => new File(["png"], name, { type: "image/png" });
    drag("drop", $("#logoTile"), { files: [png("a.png"), png("b.png")] });
    await vi.advanceTimersByTimeAsync(0);
    expect($("#logoError").hidden).toBe(false);
    expect($("#logoError").textContent).toContain("Drop one image at a time.");
    expect(squareImage).not.toHaveBeenCalled();
    expect(logoPosts()).toHaveLength(0);
    drag("drop", $("#logoTile"), { files: [png("a.png")] });
    await vi.advanceTimersByTimeAsync(0);
    expect($("#logoError").hidden).toBe(true);
    expect(logoPosts()).toHaveLength(1);
  });

  it("shows the drop target while a file is over the logo field, and clears it on leaving or dropping", async () => {
    await open([{ path: "/api/settings", reply: () => response() }, logoWrite]);
    pickedImage(512, 512);
    expect(dropTargetShows()).toBe(false);
    const over = drag("dragover", $("#logoTile"));
    expect(over.defaultPrevented).toBe(true); // what makes the slot a place a file can land
    expect(dropTargetShows()).toBe(true);
    // Crossing from the tile to a button inside the field keeps it showing…
    drag("dragleave", $("#logoTile"), { relatedTarget: $("#logoReplace") });
    expect(dropTargetShows()).toBe(true);
    // …and leaving the field, from whichever child it was over, clears it.
    drag("dragleave", $("#logoReplace"), { relatedTarget: document.body });
    expect(dropTargetShows()).toBe(false);
    drag("dragover", $("#logoTile"));
    drag("dragleave", $("#logoTile"));
    expect(dropTargetShows()).toBe(false); // no related target: the drag left the window
    drag("dragover", $("#logoTile"));
    drag("drop", $("#logoTile"), { files: [new File(["png"], "logo.png")] });
    expect(dropTargetShows()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("shows the drop target on the tile while a file is over any part of the logo field", async () => {
    await open();
    for (const part of [$("#logoTile"), $("#logoReplace"), $(".set-logo-notes")]) {
      expect(drag("dragover", part).defaultPrevented).toBe(true);
      expect(dropTargetShows()).toBe(true);
      drag("dragleave", part);
      expect(dropTargetShows()).toBe(false);
    }
  });

  it("offers no drop target for a drag that carries no file", async () => {
    await open();
    const over = drag("dragover", $("#logoTile"), { types: ["text/plain"] });
    expect(over.defaultPrevented).toBe(false);
    expect(dropTargetShows()).toBe(false);
  });

  it("says what to do when a drop promised a file and holds none, and uploads nothing", async () => {
    await open();
    vi.mocked(squareImage).mockClear();
    const e = drag("drop", $("#logoTile"), { files: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(e.defaultPrevented).toBe(true);
    expect($("#logoError").hidden).toBe(false);
    expect($("#logoError").textContent).toContain(
      "Couldn’t read a file from that drop. Save the image first, then pick it.",
    );
    expect(squareImage).not.toHaveBeenCalled();
    expect(logoPosts()).toHaveLength(0);
  });

  const LOGO_STILL_SAVING = "The last logo change is still saving. Try again once it’s done.";
  const png = (name: string) => new File(["png"], name, { type: "image/png" });

  it("refuses a drop, a pick, or Remove while an upload is under way, so an earlier choice can't land last", async () => {
    await open([
      {
        path: "/api/settings",
        reply: () =>
          response({
            settings: {
              publication: {
                name: "Birds Weekly",
                tagline: "",
                address: "",
                logo_url: "https://app.birds.example/media/branding/logo?v=1",
              },
            },
          }),
      },
      logoWrite,
    ]);
    // A large photo still decoding, as the publisher sees the mistake and tries again.
    let decoded = (_: Awaited<ReturnType<typeof squareImage>>) => {};
    vi.mocked(squareImage).mockReset();
    vi.mocked(squareImage).mockReturnValueOnce(
      new Promise((resolve) => {
        decoded = resolve;
      }),
    );
    const photo = png("photo.png");
    drag("drop", $("#logoTile"), { files: [photo] });
    await vi.advanceTimersByTimeAsync(0);

    drag("drop", $("#logoTile"), { files: [png("right.png")] });
    await vi.advanceTimersByTimeAsync(0);
    expect($("#logoError").textContent).toContain(LOGO_STILL_SAVING);
    pickLogo();
    await vi.advanceTimersByTimeAsync(0);
    $("#logoRemove").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#logoRemove").textContent).toBe("Remove");
    expect(vi.mocked(squareImage).mock.calls.map((c) => c[0])).toEqual([photo]);
    expect(logoPosts()).toHaveLength(0);
    expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false);

    // The one under way lands, its refusals no longer hold, and the next one goes.
    decoded({ png: SQUARED_PNG, width: 512, height: 512 });
    await vi.advanceTimersByTimeAsync(0);
    expect(logoPosts()).toHaveLength(1);
    expect($("#logoError").hidden).toBe(true);
    pickedImage(512, 512);
    drag("drop", $("#logoTile"), { files: [png("right.png")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(logoPosts()).toHaveLength(2);
    expect($("#logoError").hidden).toBe(true);
  });

  it("refuses a drop while Remove is under way", async () => {
    let removed = (_: unknown) => {};
    await open([
      {
        path: "/api/settings",
        reply: () =>
          response({
            settings: {
              publication: {
                name: "Birds Weekly",
                tagline: "",
                address: "",
                logo_url: "https://app.birds.example/media/branding/logo?v=1",
              },
            },
          }),
      },
      {
        method: "DELETE",
        path: "/api/settings/logo",
        reply: () =>
          new Promise((resolve) => {
            removed = resolve;
          }),
      },
      logoWrite,
    ]);
    pickedImage(512, 512);
    $("#logoRemove").click();
    await vi.advanceTimersByTimeAsync(0);
    drag("drop", $("#logoTile"), { files: [png("logo.png")] });
    await vi.advanceTimersByTimeAsync(0);
    expect($("#logoError").textContent).toContain(LOGO_STILL_SAVING);
    expect(logoPosts()).toHaveLength(0);
    removed({ settings: settings(), remade: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect($("#toasts").textContent).toMatch(/Logo removed/);
    expect($("#logoError").hidden).toBe(true);
    drag("drop", $("#logoTile"), { files: [png("logo.png")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(logoPosts()).toHaveLength(1);
  });

  it("lets the next logo change through after one fails, keeping the failure's own message until then", async () => {
    await open([{ path: "/api/settings", reply: () => response() }, logoWrite]);
    vi.mocked(squareImage).mockRejectedValueOnce(new UnreadableImage());
    drag("drop", $("#logoTile"), { files: [png("bad.png")] });
    await vi.advanceTimersByTimeAsync(0);
    expect($("#logoError").textContent).toContain("Couldn’t read that image.");
    pickedImage(512, 512);
    drag("drop", $("#logoTile"), { files: [png("good.png")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(logoPosts()).toHaveLength(1);
    expect($("#logoError").hidden).toBe(true);
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
  // SPEC §13: on SES, the Email provider row says where the connection stands (GET /api/provider).
  describe("the SES connection", () => {
    const withStatus = (over: Parameters<typeof providerStatus>[0]) =>
      open([
        { path: "/api/settings", reply: () => response() },
        { path: "/api/provider", reply: () => providerStatus(over) },
      ]);
    const account = {
      max_send_rate: 1,
      max_24_hour_send: 200,
      sent_last_24_hours: 0,
      enforcement: "healthy",
      sending_enabled: true,
    } as const;

    it("says whether email is getting out: not proven yet, refusing with the fix, or when SES accepted an email (SPEC §13)", async () => {
      await withStatus({
        state: "production",
        unknown_reason: null,
        sending: { state: "unproven", since: 0, last_accepted: null, refusal: null },
        signups: "not_open",
      });
      expect($("#providerSending").textContent).toBe("Not proven yet");
      expect($("#providerValue").textContent).toContain(
        "SES hasn’t sent anything yet, so signups are closed. Send a test email",
      );
      unmount();
      fake.restore();
      await withStatus({
        state: "production",
        unknown_reason: null,
        sending: {
          state: "refusing",
          since: 1,
          last_accepted: null,
          refusal: {
            cause: "credentials",
            found_by: "account_check",
            error: "Amazon SES rejects Kestrel’s AWS key.",
            advice: "Replace the key.",
            at: 1,
          },
        },
        signups: "paused",
      });
      expect($("#providerSending").textContent).toBe("Refusing");
      expect($("#providerSending").classList.contains("danger")).toBe(true);
      expect($("#providerValue .set-error").textContent).toBe(
        "Amazon SES rejects Kestrel’s AWS key. Replace the key. Then send a test email.",
      );
      unmount();
      fake.restore();
      await withStatus({
        state: "production",
        unknown_reason: null,
        sending: {
          state: "working",
          since: 1,
          last_accepted: { at: 1, by: "test" },
          refusal: null,
        },
      });
      expect(document.querySelector("#providerSending")).toBeNull();
      expect($("#providerLastAccepted").textContent).toBe(`SES accepted an email ${fmt(1)}.`);
    });

    it("names the sandbox, what it limits, and the step that asks AWS to lift it", async () => {
      await withStatus({
        state: "sandbox",
        unknown_reason: null,
        account,
        send_rate: { value: 1, source: "account" },
      });
      expect($("#providerState").textContent).toBe("Sandbox");
      expect($("#providerState").classList.contains("warn")).toBe(true);
      expect($("#providerReview").textContent).toBe(
        "It mails only addresses verified in SES, up to 200 a day. Request production access",
      );
      expect($<HTMLAnchorElement>("#providerReview a").getAttribute("href")).toBe(
        "#/docs/production-access",
      );
      expect($("#sendRate").textContent).toBe(
        "1 email a second, up to 200 a day (from your SES account)",
      );
      expect(fake.unhandled).toEqual([]);
    });

    it("says AWS is reviewing the request, or that it has replied in its case without a grant, never that it denied it", async () => {
      await withStatus({ state: "sandbox", unknown_reason: null, review: "pending", account });
      expect($("#providerReview").textContent).toBe(
        "AWS is reviewing your request for production access. Until then, it mails only addresses verified in SES, up to 200 a day.",
      );
      unmount();
      fake.restore();
      await withStatus({
        state: "sandbox",
        unknown_reason: null,
        review: "denied",
        review_case: "1234567890",
        account,
      });
      expect($("#providerReview").textContent).toBe(
        "AWS hasn’t granted production access yet. It has replied in AWS Support, case 1234567890: read its reply and answer there. What AWS asks for",
      );
      expect($<HTMLAnchorElement>("#providerReview a").getAttribute("href")).toBe(
        "#/docs/production-access/3-answer-awss-questions",
      );
    });

    it("marks production green, with the account's rate", async () => {
      await withStatus({
        state: "production",
        unknown_reason: null,
        account: { ...account, max_send_rate: 14, max_24_hour_send: 50_000 },
        send_rate: { value: 14, source: "account" },
      });
      expect($("#providerState").textContent).toBe("Production");
      expect($("#providerState").classList.contains("ok")).toBe(true);
      expect(document.querySelector("#providerReview")).toBeNull();
      expect($("#sendRate").textContent).toBe(
        "14 emails a second, up to 50,000 a day (from your SES account)",
      );
    });

    it("says only Amazon SES while the app can't tell, and where the rate comes from", async () => {
      await withStatus({
        unknown_reason: "not_checked",
        send_rate: { value: 1, source: "setting" },
      });
      expect($("#providerValue").textContent?.trim()).toBe("Amazon SES");
      expect(document.querySelector("#providerState")).toBeNull();
      expect(document.querySelector("#providerUnread")).toBeNull();
      expect($("#sendRate").textContent).toBe("1 email a second (set by SES_MAX_SEND_RATE)");
    });

    it("says when the key can't read the account, linking the step that allows it", async () => {
      await withStatus({ unknown_reason: "permission" });
      expect(document.querySelector("#providerState")).toBeNull();
      expect($("#providerUnread").textContent).toBe(
        "To show whether SES is in the sandbox, Kestrel’s AWS key needs permission to read your account. Add the permission",
      );
      expect($<HTMLAnchorElement>("#providerUnread a").getAttribute("href")).toBe(
        "#/docs/ses/5-create-the-apps-aws-key",
      );
      expect(fake.unhandled).toEqual([]);
    });

    it("reads a simulated account in local dev, and names the simulation beside its state (SPEC §10)", async () => {
      const local = response();
      local.deployment = {
        ...local.deployment,
        provider: "fake",
        simulation: {
          profile: "ses",
          faults: "realistic",
          refuse: null,
          account: { state: "production", bounces_routed: true, problem: null },
        },
      };
      await open([
        { path: "/api/settings", reply: () => local },
        {
          path: "/api/provider",
          reply: () =>
            providerStatus({ provider: "fake", state: "production", unknown_reason: null }),
        },
      ]);
      expect($("#providerValue").textContent?.trim()).toBe(
        "Amazon SES Production Simulating Amazon SES",
      );
      expect(fake.unhandled).toEqual([]);
    });

    it("shows each warning in the server's words, linking the step that fixes it", async () => {
      await withStatus({
        warnings: [
          {
            code: "bounces_not_routed",
            severity: "warn",
            message: "Bounces and complaints won’t reach Kestrel.",
            docs: { slug: "ses", anchor: "4-send-bounces-and-complaints-to-the-app" },
          },
        ],
      });
      expect($("#providerValue .set-warn").textContent).toBe(
        "Bounces and complaints won’t reach Kestrel. Send bounces and complaints to the app",
      );
      expect($<HTMLAnchorElement>("#providerValue .set-warn a").getAttribute("href")).toBe(
        "#/docs/ses/4-send-bounces-and-complaints-to-the-app",
      );
    });

    it("shows a warning that stops every email in red, and one that leaves sending working in amber (SPEC §13)", async () => {
      await withStatus({
        warnings: [
          {
            code: "configuration_set_missing",
            severity: "error",
            message: "SES_CONFIGURATION_SET names kestrel-mail, and SES has no such set.",
            docs: { slug: "ses", anchor: "4-send-bounces-and-complaints-to-the-app" },
          },
          {
            code: "account_probation",
            severity: "warn",
            message: "AWS is reviewing your SES account.",
            docs: { slug: "troubleshooting", anchor: "a-problem-with-amazon-ses" },
          },
        ],
      });
      expect($("#providerValue .set-error").textContent).toBe(
        "SES_CONFIGURATION_SET names kestrel-mail, and SES has no such set. Send bounces and complaints to the app",
      );
      expect($("#providerValue .set-warn").textContent).toBe(
        "AWS is reviewing your SES account. A problem with Amazon SES",
      );
      expect($<HTMLAnchorElement>("#providerValue .set-warn a").getAttribute("href")).toBe(
        "#/docs/troubleshooting/a-problem-with-amazon-ses",
      );
    });

    it("never reads the connection off SES", async () => {
      await open([
        {
          path: "/api/settings",
          reply: () => settingsResponse({ deployment: { provider: "fake" } }),
        },
      ]);
      expect(fake.calls.some((c) => c.url.pathname === "/api/provider")).toBe(false);
      expect(document.querySelector("#sendRate")).toBeNull();
    });
  });

  it("stops watching the sample email's frame on leaving the page", async () => {
    const observers = stubResizeObserver();
    await open();
    const frame = $<HTMLIFrameElement>("#tplPreview");
    frame.dispatchEvent(new Event("load"));
    const body = frame.contentDocument?.body;
    expect(body).toBeInstanceOf(HTMLElement);
    expect(observers.watching()).toContain(body);
    unmount();
    expect(observers.watching()).toEqual([]);
  });

  describe("section addresses", () => {
    /** Mount Settings as the router does for `#/settings/<section>`, recording each scroll. */
    async function openAt(section?: string) {
      fake = fakeApi([
        { path: "/api/settings", reply: () => response() },
        { path: "/api/provider", reply: () => providerStatus() },
        readerPage,
      ]);
      const targets: string[] = [];
      vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
        targets.push(this.id);
      });
      const toTop = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      await mount((root, signal) => renderSettings(root, signal, section));
      await vi.advanceTimersByTimeAsync(0);
      return { targets, toTop };
    }
    afterEach(() => {
      vi.restoreAllMocks();
      unmount();
    });

    it("gives every section head its name, in page order", async () => {
      await openAt();
      expect($$(".set-sec-head").map((h) => h.id)).toEqual(
        SETTINGS_SECTIONS.map((s) => `settings-${s}`),
      );
    });

    it("shows each section's title, the one the docs find it by", async () => {
      await openAt();
      expect(
        $$(".set-sec-title").map((t) => settingsSectionTitled(t.textContent?.trim() ?? "")),
      ).toEqual(SETTINGS_SECTIONS);
    });

    it("links each section's title to its address, and following it lands on that section", async () => {
      const { targets } = await openAt();
      expect($$("h2.set-sec-title > a").map((a) => a.getAttribute("href"))).toEqual(
        SETTINGS_SECTIONS.map((s) => `#/settings/${s}`),
      );
      for (const a of $$("h2.set-sec-title > a")) {
        expect(mounted()?.navigate?.(a.getAttribute("href") ?? "")).toBe(true);
      }
      expect(targets).toEqual(SETTINGS_SECTIONS.map((s) => `settings-${s}`));
    });

    describe("clicking a title with a section's address in the bar", () => {
      const title = () => $<HTMLAnchorElement>("#settings-notifications a");
      beforeEach(() => {
        history.replaceState(null, "", "#/settings/notifications");
      });
      afterEach(() => {
        history.replaceState(null, "", "#");
      });

      // No hashchange comes of it, so the view has to go there itself.
      it("lands on the section when the title is that section's", async () => {
        const { targets } = await openAt("notifications");
        title().click();
        expect(targets).toEqual(["settings-notifications", "settings-notifications"]);
      });

      it.each(["metaKey", "ctrlKey", "shiftKey", "altKey"])(
        "leaves a click with %s, a new tab or window, to the browser",
        async (modifier) => {
          const { targets } = await openAt("notifications");
          title().dispatchEvent(new MouseEvent("click", { bubbles: true, [modifier]: true }));
          expect(targets).toEqual(["settings-notifications"]);
        },
      );

      // That click's landing is the hash's to bring: the view going there too would hold twice.
      it("leaves a plain click on another section's title to the hash", async () => {
        const { targets } = await openAt("notifications");
        $<HTMLAnchorElement>("#settings-instance a").click();
        expect(targets).toEqual(["settings-notifications"]);
        // What the router does with the hashchange that click causes.
        expect(mounted()?.navigate?.("#/settings/instance")).toBe(true);
        expect(targets).toEqual(["settings-notifications", "settings-instance"]);
      });
    });

    it("opens at the section the address names", async () => {
      const { targets } = await openAt("notifications");
      expect(targets).toEqual(["settings-notifications"]);
    });

    // A guard: this held before sections had addresses, and fails if a page with no section
    // to show starts moving.
    it.each([undefined, "no-such-section"])(
      "opens at the top for %s, without a jump",
      async (s) => {
        const { targets } = await openAt(s);
        expect(targets).toEqual([]);
      },
    );

    it("moves between sections on the same mount, keeping unsaved edits", async () => {
      const { targets, toTop } = await openAt("notifications");
      const tagline = $<HTMLInputElement>("#setTagline");
      typeInto(tagline, "Edited, not saved");
      expect(mounted()?.navigate?.("#/settings/instance")).toBe(true);
      expect(targets).toEqual(["settings-notifications", "settings-instance"]);
      expect(mounted()?.navigate?.("#/settings")).toBe(true);
      expect(toTop).toHaveBeenCalledWith(0, 0);
      expect($<HTMLInputElement>("#setTagline")).toBe(tagline);
      expect(tagline.value).toBe("Edited, not saved");
    });

    it("lets go of one section on moving to another, so a late resize stays on the new one", async () => {
      // Only what watches the page itself; the previews have observers of their own.
      const watchers = new Set<{ el: Element; fire: () => void }>();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          entry: { el: Element; fire: () => void } | null = null;
          constructor(private fn: () => void) {}
          observe(el: Element) {
            this.entry = { el, fire: this.fn };
            watchers.add(this.entry);
          }
          unobserve() {}
          disconnect() {
            if (this.entry) {
              watchers.delete(this.entry);
            }
          }
        },
      );
      const { targets } = await openAt("notifications");
      mounted()?.navigate?.("#/settings/instance");
      targets.length = 0;
      for (const w of watchers) {
        if (w.el.classList.contains("view")) {
          w.fire();
        }
      }
      expect(targets).toEqual(["settings-instance"]);
    });

    it("hands any other address back to the router, a mangled one of its own included", async () => {
      await openAt();
      expect(mounted()?.navigate?.("#/drafts")).toBe(false);
      expect(mounted()?.navigate?.("#/settings/..")).toBe(false);
    });
  });
});
