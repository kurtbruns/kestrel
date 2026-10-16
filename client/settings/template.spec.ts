import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDRESS_NOT_PRINTED, type SettingsResponse } from "../../shared/settings";
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
  settingsResponse,
  stubClipboard,
  typeInto,
} from "../test/support";
import { fmt } from "../ui/format";
import {
  EMAIL_TEMPLATE_EXAMPLES,
  mountSampleEmailPreview,
  renderTemplate,
  sampleEmailHtml,
} from "./template";

const TEMPLATE = `<style>.email{color:#111}</style>\n<div class="email">{{ .Post.Body }}<a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a></div>`;

const response = (over: Partial<Omit<SettingsResponse, "settings">> = {}): SettingsResponse =>
  settingsResponse({
    settings: { testRecipients: ["me@b.c", "you@b.c"], emailTemplate: TEMPLATE },
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

  it("marks each footer's inbox links as email-only, and the sample (the email) shows them with no tags", () => {
    for (const ex of Object.values(EMAIL_TEMPLATE_EXAMPLES)) {
      expect(ex.html).toContain("{{ if .IsEmail }}");
      const filled = sampleEmailHtml(ex.html, id);
      expect(filled).toContain(">Unsubscribe</a>");
      expect(filled).not.toContain("{{");
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
  });
  afterEach(() => {
    fake?.restore();
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
    expect($("#tplHl code").textContent).toContain("{{ .Post.Body }}");
    expect($$("#tplHl .cx-var")).toHaveLength(2); // the two tokens, highlighted
    expect($("#tplGutter").textContent).toBe("1\n2\n");
    expect($("#reqBody").className).toBe("set-req-pill ok");
    expect($("#reqUnsub").className).toBe("set-req-pill ok");
    expect($("#tplTestLbl").textContent).toBe("Send test email");
    expect($$(".set-tpl-var code").map((c) => c.textContent)).toContain(
      "{{ .Email.UnsubscribeURL }}",
    );
    expect(bar().hidden).toBe(true);
    expect(fake.unhandled).toEqual([]);
  });

  it("an edit raises the save bar, flips the test button, and predicts a missing required variable", async () => {
    await open();
    typeInto(editor(), "<div>{{ .Post.Body }}</div>");
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
          warnings: ["No {{ .Email.ViewInBrowserURL }} link."],
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
    expect($("#tplMsgs").textContent).toBe("No {{ .Email.ViewInBrowserURL }} link.");
    expect($("#toasts").textContent).toMatch(/Template saved with warnings/);
    expect(bar().classList.contains("show")).toBe(false);
    expect(appState.appConfig?.settings.emailTemplate).toBe(stored);
  });

  it("links the mailing-address warning to the docs section, in a new tab, and no other warning", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "PUT",
        path: "/api/settings",
        reply: () => ({
          settings: response().settings,
          warnings: ["No {{ .Email.ViewInBrowserURL }} link.", ADDRESS_NOT_PRINTED],
          remade: [],
        }),
      },
    ]);
    typeInto(editor(), `${TEMPLATE} `);
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    const [plain, address] = [...$("#tplMsgs").children] as HTMLElement[];
    expect(plain!.querySelector("a")).toBeNull();
    expect(address!.textContent).toMatch(
      /^You’ve added a mailing address.*remove the address in Settings\. When to provide a mailing address/,
    );
    const link = address!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(
      "#/docs/name-your-publication/when-to-provide-a-mailing-address",
    );
    expect(link.target).toBe("_blank");
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
    typeInto(editor(), "<div>{{ .Post.Body }}</div>");
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(bar().classList.contains("is-error")).toBe(true);
    expect($(".savebar-msg").textContent).toMatch(/no unsubscribe link/);
    expect(editor().value).toBe("<div>{{ .Post.Body }}</div>");
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
      /This template is used by 1 post that’s already scheduled/,
    );
    $("#rmGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    expect($("#toasts").textContent).toMatch(/Template saved and applied to 1 scheduled email/);
  });

  it("says in the lede, not on the in-use chip, when a post about to send lets a save through (DESIGN §11)", async () => {
    const at = Date.now() + 120_000;
    const sends = [{ id: "x1", post_id: "p1", subject: "Gulls", fire_at: at, remade_at: null }];
    await open([
      {
        path: "/api/settings",
        reply: () => response({ inUse: { sends, retry_after: at, identityFields: [] } }),
      },
    ]);
    expect($(".set-chip.inuse").textContent).toBe("In use by 1 scheduled post");
    expect($(".set-chip.inuse").hasAttribute("title")).toBe(false);
    expect($(".set-page-lede").contains($("#tplWait"))).toBe(true);
    expect($("#tplWait").textContent).toBe(
      ` A scheduled post sends at ${fmt(at)}. You can save once it has sent.`,
    );
  });

  it("drops the word that saving has to wait once that time has passed", async () => {
    const at = Date.now() + 120_000;
    const sends = [{ id: "x1", post_id: "p1", subject: "Gulls", fire_at: at, remade_at: null }];
    await open([
      {
        path: "/api/settings",
        reply: () => response({ inUse: { sends, retry_after: at, identityFields: [] } }),
      },
    ]);
    await vi.advanceTimersByTimeAsync(119_000);
    expect($("#tplWait").textContent).toMatch(/You can save once it has sent\.$/);
    await vi.advanceTimersByTimeAsync(1_000);
    expect($("#tplWait").textContent).toBe("");
    expect($(".set-page-lede").textContent).toContain("rendered into {{ .Post.Body }}.");
  });

  it("leaves the lede to the template while no post is about to send", async () => {
    await open();
    expect($(".set-page-lede").textContent).toContain("rendered into {{ .Post.Body }}.");
    expect($("#tplWait").textContent).toBe("");
  });

  it("keeps the edit and the bar when the publisher backs out of applying it", async () => {
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
        reply: () => jsonResponse({ error: "remake_required", message: "ack", sends }, 409),
      },
    ]);
    typeInto(editor(), `${TEMPLATE}<!-- v2 -->`);
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    $("#rmCancel").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(editor().value).toBe(`${TEMPLATE}<!-- v2 -->`);
    expect(bar().classList.contains("show")).toBe(true);
    expect(bar().classList.contains("is-error")).toBe(false); // declined, not refused
    expect($("#toasts").textContent).toBe("");
  });

  it("shows a send about to fire as the bar's blocking error, keeping the edit", async () => {
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
    typeInto(editor(), `${TEMPLATE}<!-- v2 -->`);
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".modal")).toBeNull(); // nothing to acknowledge
    expect(bar().classList.contains("is-error")).toBe(true);
    expect($(".savebar-msg").textContent).toMatch(/sends in 3 minutes/);
    expect(editor().value).toBe(`${TEMPLATE}<!-- v2 -->`);
    expect($("#toasts").textContent).toBe(""); // the bar says it; no toast over it
  });

  it("loads an example from the menu, closes it on an outside click, and discards back to the baseline", async () => {
    await open();
    const btn = $("#tplExamplesBtn");
    btn.click();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect($$(".menu .menu-item-name").map((n) => n.textContent)).toEqual(["Signed", "Plain"]);
    $(".menu-overlay").click(); // an outside click
    expect(document.querySelector(".menu")).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    btn.click();
    $$<HTMLButtonElement>(".menu-item")[1]?.click();
    expect(document.querySelector(".menu")).toBeNull();
    expect(editor().value).toBe(EMAIL_TEMPLATE_EXAMPLES.plain.html);
    expect(editor().value).not.toContain("signoff");
    expect(bar().classList.contains("show")).toBe(true);
    $("#savebarDiscard").click();
    expect(editor().value).toBe(TEMPLATE);
    expect(bar().classList.contains("show")).toBe(false);
  });

  it("the example menu is a menu for the keyboard: first item focused, arrows move, Escape returns to the button (DESIGN §11)", async () => {
    await open();
    const btn = $("#tplExamplesBtn");
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    btn.focus();
    btn.click();
    const key = (k: string) =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
      );
    const focused = () => document.activeElement?.querySelector(".menu-item-name")?.textContent;
    expect($(".menu").getAttribute("role")).toBe("menu");
    expect($$(".menu [role='menuitem']")).toHaveLength(2);
    expect(focused()).toBe("Signed");
    key("ArrowDown");
    expect(focused()).toBe("Plain");
    key("Home");
    expect(focused()).toBe("Signed");
    key("Escape");
    expect(document.querySelector(".menu")).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(editor().value).toBe(TEMPLATE); // nothing picked, nothing loaded
  });

  it("the test dialog carries a standing line to connect a provider while no provider is connected (DESIGN §4)", async () => {
    appState.appConfig = settingsResponse({ deployment: { provider: "none" } });
    await open();
    $("#tplTest").click();
    const line = $(".modal .not-connected");
    expect(line.textContent).toMatch(/^No email provider connected/);
    expect($<HTMLAnchorElement>("a", line).getAttribute("href")).toBe("#/docs/ses");
    expect($<HTMLButtonElement>("#ttGo").disabled).toBe(true);
    expect(document.querySelector(".modal #tplTestTo")).toBeNull();
    $("#ttCancel").click();
    appState.appConfig = settingsResponse({ deployment: { provider: "ses" } });
    $("#tplTest").click();
    expect(document.querySelector(".modal .not-connected")).toBeNull();
    expect($<HTMLButtonElement>("#ttGo").disabled).toBe(false);
    expect(document.querySelector(".modal #tplTestTo")).not.toBeNull();
  });

  it("says nothing of saving first while no provider is connected, since nothing will be sent", async () => {
    appState.appConfig = settingsResponse({ deployment: { provider: "none" } });
    await open();
    typeInto(editor(), `${TEMPLATE}<!-- v2 -->`);
    $("#tplTest").click();
    expect($(".modal").textContent).not.toMatch(/Unsaved changes/);
    expect($("#ttGo").textContent).toBe("Send test");
    expect($<HTMLButtonElement>("#ttGo").disabled).toBe(true);
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
        reply: (req) => ({
          sent: 2,
          total: (req.json() as { to: string[] }).to.length,
          failed: [],
        }),
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

  it("a test that misses some addresses stays open with only those, naming each and why, so Send again mails no one twice (SPEC §5)", async () => {
    await open([
      { path: "/api/settings", reply: () => response() },
      {
        method: "POST",
        path: "/api/settings/template/test",
        reply: () => ({
          sent: 1,
          total: 2,
          failed: ["you@b.c"],
          not_sent: [
            {
              email: "you@b.c",
              may_have_arrived: false,
              error: "ses 400 MessageRejected: Email address is not verified.",
              message:
                "The provider refused it: ses 400 MessageRejected: Email address is not verified. Sending to this address again gets the same answer until what the provider names is fixed.",
            },
          ],
        }),
      },
    ]);
    $("#tplTest").click();
    $("#ttGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".modal")).not.toBeNull();
    expect($<HTMLTextAreaElement>("#tplTestTo").value).toBe("you@b.c");
    expect($(".modal .dialog-error").textContent).toBe(
      "!Sent to 1 of 2. you@b.c: The provider refused it: ses 400 MessageRejected: Email address is not verified. Sending to this address again gets the same answer until what the provider names is fixed. Send again goes only to those.",
    );
    expect($("#toasts").textContent).toBe("");
    expect(fake.unhandled).toEqual([]);
  });

  it("copies the whole template and says so on the button, not in a toast", async () => {
    const writeText = stubClipboard();
    await open();
    $("#tplCopyAll").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith(editor().value);
    expect($("#tplCopyAll").getAttribute("aria-label")).toBe("Copied");
    expect($("#toasts").textContent).toBe("");
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
    const pressed = () => $$(".wtog-btn").map((b) => b.getAttribute("aria-pressed"));
    expect(pressed()).toEqual(["true", "false"]);
    $(".wtog-btn[data-w='375']").click();
    expect($<HTMLIFrameElement>("#tplPreview").style.maxWidth).toBe("375px");
    expect(pressed()).toEqual(["false", "true"]);
    $(".wtog-btn[data-w='640']").click();
    expect($<HTMLIFrameElement>("#tplPreview").style.maxWidth).toBe("640px");
    expect(pressed()).toEqual(["true", "false"]);
  });
});

describe("sample email preview", () => {
  const SIGNOFF =
    '<div class="email">{{ .Post.Body }}<table><tr><td class="logo-cell">{{ .Publication.Logo }}</td><td>{{ .Publication.Name }}</td></tr></table></div>';
  const identity = { name: "Birds Weekly", tagline: "", address: "" };

  function preview(logoUrl: string, template = SIGNOFF): HTMLElement {
    resetShell();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    mountSampleEmailPreview(
      frame,
      () => template,
      () => ({ ...identity, logoUrl }),
    );
    frame.dispatchEvent(new Event("load"));
    const slot = frame.contentDocument?.querySelector<HTMLElement>(".kestrel-email");
    if (!slot) {
      throw new Error("the preview painted nothing");
    }
    return slot;
  }

  it("shows no logo, and no stand-in, when none is set: the sign-off the email will carry", () => {
    const slot = preview("");
    expect(slot.querySelector("img")).toBeNull();
    expect(slot.querySelector(".logo-cell")?.innerHTML).toBe("");
    expect(slot.textContent).toContain("Birds Weekly");
  });

  it("shows the real logo when one is set", () => {
    const img = preview("https://app.birds.example/media/branding/logo?v=1").querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://app.birds.example/media/branding/logo?v=1");
    expect(img?.getAttribute("alt")).toBe("Birds Weekly");
  });

  it("runs nothing the template carries: the frame has the Preview tab's sandbox, with no script or form (SPEC §5)", () => {
    resetShell();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    mountSampleEmailPreview(
      frame,
      () => SIGNOFF,
      () => ({ ...identity, logoUrl: "" }),
    );
    expect(frame.getAttribute("sandbox")?.split(" ")).toEqual([
      "allow-same-origin",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
    ]);
  });

  it("opens the template's links in a new tab, so following one never blanks the frame", () => {
    const link = preview("", '<p><a href="https://birds.example/">Visit</a></p>').querySelector(
      "a",
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
