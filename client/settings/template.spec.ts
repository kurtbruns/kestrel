import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse } from "../../shared/settings";
import { appState } from "../state";
import {
  $,
  $$,
  type FakeApi,
  type FakeRoute,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  typeInto,
} from "../test/support";
import { EMAIL_TEMPLATE_EXAMPLES, renderTemplate, sampleEmailHtml } from "./template";

const TEMPLATE = `<style>.email{color:#111}</style>\n<div class="email">{{ post.body }}<a href="{{ email.unsubscribeUrl }}">Unsubscribe</a></div>`;

const response = (over: Partial<SettingsResponse> = {}): SettingsResponse => ({
  settings: {
    testRecipients: ["me@b.c", "you@b.c"],
    publication: { name: "Birds Weekly", tagline: "", address: "", logoUrl: "" },
    emailTemplate: TEMPLATE,
    confirmationEmail: { subject: "", body: "", buttonLabel: "", reassurance: "" },
    confirmationEmailDefault: { subject: "s", body: "b", buttonLabel: "c", reassurance: "" },
    notifications: { to: "" },
  },
  deployment: {
    provider: "fake",
    fromAddress: "Birds <hello@birds.example>",
    sendingDomain: "birds.example",
    appOrigin: "https://app.birds.example",
    archiveOrigin: "https://app.birds.example",
    archiveBasePath: "/archive",
    mediaPublicBase: "https://app.birds.example/media",
    awsRegion: "",
    accessConfigured: false,
    authMode: "dev",
    notifyChannel: "fake",
    notifyFrom: "Birds <hello@birds.example>",
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
  notificationStatus: { lastSent: null, lastFailure: null },
  inUse: { sends: [], retry_after: null, identityFields: ["name"] },
  ...over,
});

const bar = () => $("#savebar");
const editor = () => $<HTMLTextAreaElement>("#tplEditor");

describe("starting templates", () => {
  // The footer's address line in a filled template, or undefined when there is none.
  const addressLine = (filled: string) => {
    const doc = new DOMParser().parseFromString(filled, "text/html");
    return doc.querySelector(".footer .address")?.textContent;
  };
  const id = { name: "Birds Weekly", tagline: "", logoUrl: "", address: "" };

  it("offers Signed and Plain, each printing the address once set and nothing while blank", () => {
    expect(Object.values(EMAIL_TEMPLATE_EXAMPLES).map((ex) => ex.label)).toEqual([
      "Signed",
      "Plain",
    ]);
    for (const ex of Object.values(EMAIL_TEMPLATE_EXAMPLES)) {
      // A blank address previews as blank, never as a placeholder the email won't have.
      expect(addressLine(sampleEmailHtml(ex.html, id))).toBe("");
      expect(addressLine(sampleEmailHtml(ex.html, { ...id, address: "PO Box 1142" }))).toBe(
        "PO Box 1142",
      );
    }
  });
});

describe("template view", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    localStorage.clear();
    vi.useFakeTimers();
    location.hash = "#/template";
    appState.appConfig = null;
  });
  afterEach(() => {
    fake?.restore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function open(routes: FakeRoute[] = [{ path: "/api/settings", reply: () => response() }]) {
    fake = fakeApi(routes);
    await mount(renderTemplate);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("renders the in-use chip, the saved template in the editor with its highlight and gutter, and the required pills", async () => {
    await open();
    expect($("#tplInUse").textContent).toContain("No posts scheduled");
    expect(editor().value).toBe(TEMPLATE);
    expect($("#tplHl code").textContent).toContain("{{ post.body }}");
    expect($$("#tplHl .cx-var")).toHaveLength(2); // the two tokens, highlighted
    expect($("#tplGutter").textContent).toBe("1\n2\n");
    expect($("#reqBody").className).toBe("set-req-pill ok");
    expect($("#reqUnsub").className).toBe("set-req-pill ok");
    expect($("#tplTestLbl").textContent).toBe("Send test email");
    expect($$(".set-tpl-var code").map((c) => c.textContent)).toContain(
      "{{ email.unsubscribeUrl }}",
    );
    expect(bar().hidden).toBe(true);
    expect(fake.unhandled).toEqual([]);
  });

  it("an edit raises the save bar, flips the test button, and predicts a missing required variable", async () => {
    await open();
    typeInto(editor(), "<div>{{ post.body }}</div>");
    expect(bar().classList.contains("show")).toBe(true);
    expect($("#reqUnsub").className).toBe("set-req-pill bad");
    expect($("#tplTestLbl").textContent).toBe("Save & send test");
    expect($("#tplGutter").textContent).toBe("1\n");
  });

  it("saves the template, shows the server's warnings, and adopts what was stored", async () => {
    const stored = `${TEMPLATE}\n`;
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "PUT",
        path: "/api/settings",
        reply: () => ({
          settings: { ...response().settings, emailTemplate: stored },
          warnings: ["No {{ email.viewInBrowserUrl }} link."],
          remade: [],
        }),
      },
    ]);
    typeInto(editor(), `${TEMPLATE} `);
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.json()).toEqual({ emailTemplate: `${TEMPLATE} ` });
    expect(editor().value).toBe(stored);
    expect($("#tplMsgs").hidden).toBe(false);
    expect($("#tplMsgs").textContent).toBe("No {{ email.viewInBrowserUrl }} link.");
    expect($("#toasts").textContent).toMatch(/Template saved with warnings/);
    expect(bar().classList.contains("show")).toBe(false);
    expect(appState.appConfig?.settings.emailTemplate).toBe(stored);
  });

  it("a rejected template keeps the bar up with the reason", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "PUT",
        path: "/api/settings",
        reply: () =>
          jsonResponse(
            { error: "bad_request", message: "The template has no unsubscribe link." },
            400,
          ),
      },
    ]);
    typeInto(editor(), "<div>{{ post.body }}</div>");
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(bar().classList.contains("is-error")).toBe(true);
    expect($(".savebar-msg").textContent).toMatch(/no unsubscribe link/);
    expect(editor().value).toBe("<div>{{ post.body }}</div>");
    expect($("#toasts").textContent).toBe(""); // the bar says it; no toast over it
  });

  it("asks before a save that re-makes scheduled emails and reports what was applied", async () => {
    const sends = [
      { id: "x1", post_id: "p1", subject: "Gulls", fire_at: 1_800_000_000_000, remade_at: null },
    ];
    await open([
      {
        path: "/api/settings",
        reply: () => response({ inUse: { sends, retry_after: null, identityFields: [] } }),
      },
      {
        method: "PUT",
        path: "/api/settings",
        reply: (req) =>
          (req.json() as { remake?: string[] }).remake
            ? { settings: response().settings, warnings: [], remade: sends }
            : jsonResponse({ error: "remake_required", message: "ack", sends }, 409),
      },
    ]);
    expect($("#tplInUse").textContent).toContain("In use by 1 scheduled post");
    typeInto(editor(), `${TEMPLATE}<!-- v2 -->`);
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($(".modal .hint").textContent).toMatch(
      /This template is used by 1 post that's already scheduled/,
    );
    $("#rmGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    expect($("#toasts").textContent).toMatch(/Template saved and applied to 1 scheduled email/);
  });

  it("loads an example from the menu, closes it on an outside click, and discards back to the baseline", async () => {
    await open();
    $("#tplExamplesBtn").click();
    expect($("#tplExamplesList").hidden).toBe(false);
    expect($$<HTMLButtonElement>("[data-example]").map((b) => b.dataset.example)).toEqual([
      "signed",
      "plain",
    ]);
    document.body.click();
    expect($("#tplExamplesList").hidden).toBe(true);
    $("#tplExamplesBtn").click();
    $("[data-example='plain']").click();
    expect($("#tplExamplesList").hidden).toBe(true);
    expect(editor().value).toBe(EMAIL_TEMPLATE_EXAMPLES.plain.html);
    expect(editor().value).not.toContain("signoff");
    expect(bar().classList.contains("show")).toBe(true);
    $("#savebarDiscard").click();
    expect(editor().value).toBe(TEMPLATE);
    expect(bar().classList.contains("show")).toBe(false);
  });

  it("save & send test: saves the edits first, then posts the test to the pre-filled recipients", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "PUT",
        path: "/api/settings",
        reply: (req) => ({
          settings: {
            ...response().settings,
            emailTemplate: (req.json() as { emailTemplate: string }).emailTemplate,
          },
          warnings: [],
          remade: [],
        }),
      },
      {
        method: "POST",
        path: "/api/settings/template/test",
        reply: (req) => ({ sent: 2, total: (req.json() as { to: string[] }).to.length }),
      },
    ]);
    typeInto(editor(), `${TEMPLATE}<!-- v2 -->`);
    $("#tplTest").click();
    expect($("#ttGo").textContent).toBe("Save & send test");
    expect($<HTMLTextAreaElement>("#tplTestTo").value).toBe("me@b.c\nyou@b.c");
    $("#ttGo").click();
    await vi.advanceTimersByTimeAsync(0);
    const order = fake.calls.map((c) => `${c.method} ${c.url.pathname}`);
    expect(order).toEqual([
      "GET /api/settings",
      "PUT /api/settings",
      "POST /api/settings/template/test",
    ]);
    expect(fake.calls[2]?.json()).toEqual({ to: ["me@b.c", "you@b.c"] });
    expect($("#toasts").textContent).toMatch(/Test sent to 2 addresses/);
    expect(bar().classList.contains("show")).toBe(false); // saved on the way
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("remembers the line-number toggle per browser", async () => {
    await open();
    expect($("#tplEditorWrap").classList.contains("show-lines")).toBe(false);
    $("#tplLineNums").click();
    expect($("#tplEditorWrap").classList.contains("show-lines")).toBe(true);
    expect($("#tplLineNums").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("kestrel.tpl.lineNums")).toBe("1");
    await mount(renderTemplate);
    await vi.advanceTimersByTimeAsync(0);
    expect($("#tplEditorWrap").classList.contains("show-lines")).toBe(true);
  });

  it("proofs both inbox widths", async () => {
    await open();
    $(".wtog-btn[data-w='375']").click();
    expect($<HTMLIFrameElement>("#tplPreview").style.maxWidth).toBe("375px");
    expect($$(".wtog-btn").map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
  });
});
