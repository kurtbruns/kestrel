import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse, SettingsView } from "../../shared/settings";
import { savebar } from "../savebar";
import { appState } from "../state";
import {
  $,
  $$,
  type FakeApi,
  type FakeRoute,
  fakeApi,
  jsonResponse,
  resetShell,
  typeInto,
} from "../test_support";
import { renderSettings } from "./settings";

const DEFAULT_COPY = {
  subject: "Confirm your subscription",
  body: "Click below to confirm.",
  buttonLabel: "Confirm",
  reassurance: "If this wasn't you, ignore this email.",
};

const settings = (over: Partial<SettingsView> = {}): SettingsView => ({
  testRecipients: ["me@b.c"],
  publication: { name: "Birds Weekly", tagline: "Owls & more", address: "", logoUrl: "" },
  emailTemplate: '<div>{{ post.body }}<a href="{{ email.unsubscribeUrl }}">out</a></div>',
  confirmationEmail: { subject: "", body: "", buttonLabel: "", reassurance: "" },
  confirmationEmailDefault: DEFAULT_COPY,
  ...over,
});

const response = (over: Partial<SettingsResponse> = {}): SettingsResponse => ({
  settings: settings(),
  deployment: {
    provider: "ses",
    fromAddress: "Birds <hello@send.birds.example>",
    sendingDomain: "send.birds.example",
    appOrigin: "https://app.birds.example",
    archiveOrigin: "https://app.birds.example",
    archiveBasePath: "/archive",
    mediaPublicBase: "https://app.birds.example/media",
    awsRegion: "us-east-1",
    accessConfigured: false,
    authMode: "dev",
    build: {
      version: "",
      sha: "dev",
      tag: "",
      buildTime: "",
      repoUrl: "",
      commitUrl: "",
      tagUrl: "",
    },
  },
  inUse: { sends: [], retry_after: null, identityFields: ["name", "logoUrl"] },
  ...over,
});

const bar = () => $("#savebar");

describe("settings view", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
    location.hash = "#/settings";
    appState.appConfig = null;
  });
  afterEach(() => {
    fake?.restore();
    savebar.detach();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function mount(routes: FakeRoute[] = [{ path: "/api/settings", reply: () => response() }]) {
    fake = fakeApi(routes);
    await renderSettings();
    await vi.advanceTimersByTimeAsync(0);
  }

  it("renders the identity, the sender and instance reflections, the recipients, the subscribe embed, and the confirmation preview", async () => {
    await mount();
    expect($<HTMLInputElement>("#setName").value).toBe("Birds Weekly");
    expect($<HTMLInputElement>("#setTagline").value).toBe("Owls & more");
    expect($(".set-note span").textContent).toMatch(
      /Your name, and logo ride inside every email; the template doesn’t use your tagline, and mailing address\./,
    );
    expect($$(".set-inbox-from")[0]?.textContent).toBe("Birds");
    expect($(".set-inbox-addr").textContent).toBe("hello@send.birds.example");
    const facts = $$(".set-kv-v").map((v) => v.textContent?.trim());
    expect(facts).toContain("Amazon SES");
    expect(facts).toContain("Local dev token");
    expect(facts).toContain("Not configured");
    expect($(".set-pill").textContent).toBe("default: app origin"); // archive on the app origin
    expect($$(".set-recip-chip").map((c) => c.textContent?.trim())).toEqual(["me@b.c"]);
    expect($(".pub-val").textContent).toBe("https://app.birds.example/subscribe");
    expect($("#embedCode").textContent).toContain(
      `<form action="https://app.birds.example/subscribe" method="post">`,
    );
    expect($("#embedPreview label").textContent).toBe("Subscribe to Birds Weekly");
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

  it("raises the save bar on an edit and drops it on discard, restoring the field", async () => {
    await mount();
    typeInto($<HTMLInputElement>("#setName"), "Birds Monthly");
    expect(bar().classList.contains("show")).toBe(true);
    expect($("#embedPreview label").textContent).toBe("Subscribe to Birds Monthly"); // live
    $("#savebarDiscard").click();
    expect($<HTMLInputElement>("#setName").value).toBe("Birds Weekly");
    expect(bar().classList.contains("show")).toBe(false);
  });

  it("saves the identity, recipients, and wording, adopting the server's normalized result and the sidebar brand", async () => {
    await mount([
      { path: "/api/settings", reply: () => response() },
      {
        method: "PUT",
        path: "/api/settings",
        reply: (req) => {
          const body = req.json() as { publication: { name: string }; testRecipients: string[] };
          return {
            settings: settings({
              publication: {
                name: body.publication.name.trim(),
                tagline: "",
                address: "",
                logoUrl: "",
              },
              testRecipients: body.testRecipients.map((r) => r.toLowerCase()),
              confirmationEmail: { ...DEFAULT_COPY, subject: "Please confirm" },
            }),
            warnings: [],
            remade: [],
          };
        },
      },
    ]);
    typeInto($<HTMLInputElement>("#setName"), "  Birds Monthly  ");
    typeInto($<HTMLInputElement>("#recipInput"), "New@B.C");
    $("#recipAdd").click();
    $("#ceTabEdit").click();
    typeInto($<HTMLInputElement>("#ceSubject"), "Please confirm");
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.json()).toEqual({
      publication: { name: "Birds Monthly", tagline: "Owls & more", address: "" },
      testRecipients: ["me@b.c", "new@b.c"],
      confirmationEmail: { subject: "Please confirm", body: "", buttonLabel: "", reassurance: "" },
    });
    expect($<HTMLInputElement>("#setTagline").value).toBe(""); // the server's result is the baseline now
    expect($$(".set-recip-chip").map((c) => c.textContent?.trim())).toEqual(["me@b.c", "new@b.c"]);
    expect($<HTMLInputElement>("#ceMessage").value).toBe(DEFAULT_COPY.body);
    expect($("#brandName").textContent).toBe("Birds Monthly");
    expect(appState.appConfig?.settings.publication.name).toBe("Birds Monthly");
    expect($("#toasts").textContent).toMatch(/Settings saved/);
    expect(bar().classList.contains("show")).toBe(false);
  });

  it("asks before a save that re-makes scheduled emails, then retries with the acknowledgement", async () => {
    const sends = [
      { id: "x1", post_id: "p1", subject: "Gulls", fire_at: 1_800_000_000_000, remade_at: null },
    ];
    await mount([
      {
        path: "/api/settings",
        reply: () => response({ inUse: { sends, retry_after: null, identityFields: ["name"] } }),
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
    expect($(".set-chip.inuse").textContent).toBe("In use by 1 scheduled post");
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

  it("shows a send about to fire as the bar's blocking error, keeping the edits", async () => {
    await mount([
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

  it("validates a recipient before adding it, and removes one from its chip", async () => {
    await mount();
    const input = $<HTMLInputElement>("#recipInput");
    typeInto(input, "nope");
    $("#recipAdd").click();
    expect($("#toasts").textContent).toMatch(/doesn’t look like an email address/);
    typeInto(input, "ME@b.c");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect($("#toasts").textContent).toMatch(/already in the list/);
    expect($$(".set-recip-chip")).toHaveLength(1);
    expect(bar().classList.contains("show")).toBe(false);
    $(".set-recip-chip [data-rm='0']").click();
    expect($("#recipChips").textContent).toMatch(/No default recipients yet/);
    expect(bar().classList.contains("show")).toBe(true);
  });

  it("edits the confirmation wording with a live preview, and resets to the default", async () => {
    await mount();
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

  it("switches the embed snippet and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await mount();
    $("[data-embed='styled']").click();
    expect($("#embedCode").textContent).toContain('style="max-width:420px');
    expect($("#embedHint").textContent).toMatch(/Self-contained/);
    expect($("#embedPreview form").className).toBe("set-pf-styled");
    $("#embedCopy").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Subscribe to Birds Weekly"));
    expect(writeText.mock.calls[0]?.[0]).toContain("style=");
  });

  it("uploads a logo at once, and removes it", async () => {
    const withLogo = settings({
      publication: {
        name: "Birds Weekly",
        tagline: "",
        address: "",
        logoUrl: "https://app.birds.example/media/branding/logo?v=1",
      },
    });
    await mount([
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
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fake.calls.some((c) => c.method === "POST" && c.url.pathname === "/api/settings/logo"),
    ).toBe(true);
    expect($("#logoTile").classList.contains("has-img")).toBe(true);
    expect($("#logoTile").style.backgroundImage).toContain("branding/logo?v=1");
    expect($("#logoRemove").hidden).toBe(false);
    expect($("#toasts").textContent).toMatch(/Logo updated/);
    // The confirmation preview's masthead picks the logo up on its next repaint (an
    // identity or wording edit), as it always has; the tile and template preview at once.
    typeInto($<HTMLInputElement>("#setTagline"), "Owls");
    expect($("#cePvMastLogo img").getAttribute("src")).toContain("branding/logo?v=1");
    $("#savebarDiscard").click();
    $("#logoRemove").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#logoTile").classList.contains("has-img")).toBe(false);
    expect($("#logoRemove").hidden).toBe(true);
    expect($("#toasts").textContent).toMatch(/Logo removed/);
    expect(bar().classList.contains("show")).toBe(false); // the logo never dirties the bar
  });

  it("shows the error with a retry", async () => {
    let failures = 1;
    await mount([
      {
        path: "/api/settings",
        reply: () => (failures-- > 0 ? jsonResponse({ error: "down" }, 500) : response()),
      },
    ]);
    expect($("#settingsBody .error").textContent).toMatch(/down/);
    $("[data-retry]").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($<HTMLInputElement>("#setName").value).toBe("Birds Weekly");
  });
});
