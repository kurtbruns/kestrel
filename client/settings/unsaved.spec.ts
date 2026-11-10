import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsPatchBody, SettingsView } from "../../shared/settings";
import { installRouter } from "../router";
import {
  $,
  type FakeApi,
  type FakeRoute,
  fakeApi,
  jsonResponse,
  resetShell,
  settingsResponse,
  settle,
  typeInto,
  unmount,
} from "../test/support";

// The leave guard on the two pages that save by hand (DESIGN §6), through the real router:
// its listeners are installed once per file, as boot does once per page. hashchange is
// dispatched by hand, as in router.spec.ts; happy-dom's own later echo lands on the hash
// already mounted and is nothing to do.
const hashchange = () => window.dispatchEvent(new Event("hashchange"));
async function at(hash: string) {
  location.hash = hash;
  hashchange();
  await settle();
}
const h1 = () => $("#app h1").textContent;
const bar = () => $("#savebar");
const unloadCancelled = () => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};
const pressSave = () => {
  const e = new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

// A write answered as the server stores it: what was sent, over the settings as read.
function saved(body: SettingsPatchBody): { settings: SettingsView; warnings: []; remade: [] } {
  const s = settingsResponse().settings;
  return {
    settings: {
      ...s,
      publication: { ...s.publication, ...body.publication },
      confirmation_email: { ...s.confirmation_email, ...body.confirmation_email },
      test_recipients: body.test_recipients ?? s.test_recipients,
      email_template: body.email_template ?? s.email_template,
    },
    warnings: [],
    remade: [],
  };
}
const put: FakeRoute = {
  method: "PUT",
  path: "/api/settings",
  reply: (req) => saved(req.json() as SettingsPatchBody),
};
const refused: FakeRoute = {
  method: "PUT",
  path: "/api/settings",
  reply: () => jsonResponse({ error: "internal_error", message: "Database unavailable" }, 500),
};
// Every held save, answered in cleanup if a test didn't, so a busy Save never outlives it.
const holding: (() => void)[] = [];
/** A save that waits until the test lets it answer. */
function heldPut(answer: (req: { json(): unknown }) => unknown) {
  let release = () => {};
  holding.push(() => release());
  const route: FakeRoute = {
    method: "PUT",
    path: "/api/settings",
    reply: (req) =>
      new Promise((resolve) => {
        release = () => resolve(answer(req));
      }),
  };
  return { route, release: () => release() };
}

describe("leaving a page with unsaved edits", () => {
  let fake: FakeApi;
  let confirm: ReturnType<typeof vi.fn<() => boolean>>;
  beforeAll(() => {
    installRouter();
  });
  beforeEach(() => {
    resetShell();
    confirm = vi.fn(() => false);
    // happy-dom has no confirm(); the router calls the global, so stand one in.
    vi.stubGlobal("confirm", confirm);
  });
  // Putting the URL back is itself a leave: let it go, so a page left dirty doesn't hold the
  // hash for the next test.
  afterEach(async () => {
    confirm.mockReturnValue(true);
    for (const release of holding.splice(0)) {
      release();
    }
    history.replaceState(null, "", "/dashboard/");
    await settle();
    unmount();
    fake?.restore();
    vi.unstubAllGlobals();
  });

  async function open(hash: string, write: FakeRoute = put) {
    fake = fakeApi([
      { path: "/api/settings", reply: () => settingsResponse() },
      write,
      { path: /^\/api\/reader-pages\//, reply: () => new Response("<html><body></body></html>") },
      {
        path: "/api/subscribers",
        reply: () => ({
          subscribers: [],
          counts: { pending: 0, confirmed: 0, unsubscribed: 0, suppressed: 0 },
          page: { total: 0, limit: 50, offset: 0 },
        }),
      },
    ]);
    await at(hash);
  }

  describe("Settings", () => {
    const tagline = () => $<HTMLInputElement>("#setTagline");

    it("asks before leaving with an edit, keeps the page and the edit on No, and leaves on Yes", async () => {
      await open("#/settings");
      typeInto(tagline(), "Owls & more");
      await at("#/subscribers");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith("You have unsaved changes. Leave without saving?");
      expect(location.hash).toBe("#/settings");
      expect(h1()).toBe("Settings");
      expect(tagline().value).toBe("Owls & more");
      expect(bar().classList.contains("show")).toBe(true);
      confirm.mockReturnValue(true);
      await at("#/subscribers");
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(h1()).toBe("Subscribers");
      expect(fake.unhandled).toEqual([]);
    });

    it("leaves a clean page unasked", async () => {
      await open("#/settings");
      await at("#/subscribers");
      expect(confirm).not.toHaveBeenCalled();
      expect(h1()).toBe("Subscribers");
    });

    it("has the browser warn on unload only while an edit is unsaved", async () => {
      await open("#/settings");
      expect(unloadCancelled()).toBe(false);
      typeInto(tagline(), "Owls & more");
      expect(unloadCancelled()).toBe(true);
      $("#savebarDiscard").click();
      expect(unloadCancelled()).toBe(false);
    });

    it("moves between its own sections without asking, the edit kept", async () => {
      await open("#/settings");
      typeInto(tagline(), "Owls & more");
      await at("#/settings/notifications");
      expect(confirm).not.toHaveBeenCalled();
      expect(location.hash).toBe("#/settings/notifications");
      expect(tagline().value).toBe("Owls & more");
    });

    it("is clean after Save changes or Discard, so a leave doesn't ask", async () => {
      await open("#/settings");
      typeInto(tagline(), "Owls & more");
      $("#savebarSave").click();
      await settle();
      expect(unloadCancelled()).toBe(false);
      typeInto(tagline(), "Owls only");
      $("#savebarDiscard").click();
      await at("#/subscribers");
      expect(confirm).not.toHaveBeenCalled();
      expect(h1()).toBe("Subscribers");
    });

    it("isn't made dirty by an address added to a list, which saves at once, or by one typed and not added", async () => {
      await open("#/settings");
      typeInto($<HTMLInputElement>("#recipInput"), "new@b.c");
      $("#recipAdd").click();
      await settle();
      expect(fake.calls.filter((c) => c.method === "PUT").map((c) => c.json())).toEqual([
        { test_recipients: ["new@b.c"] },
      ]);
      typeInto($<HTMLInputElement>("#notifyTo"), "half@b");
      expect(unloadCancelled()).toBe(false);
      await at("#/subscribers");
      expect(confirm).not.toHaveBeenCalled();
      expect(h1()).toBe("Subscribers");
    });

    it("saves on ⌘S exactly as Save changes does, and does nothing on a clean page", async () => {
      await open("#/settings");
      expect(pressSave()).toBe(true); // the browser's own Save page never opens here
      expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
      typeInto(tagline(), "Owls & more");
      pressSave();
      await settle();
      const writes = fake.calls.filter((c) => c.method === "PUT").map((c) => c.json());
      expect(writes).toHaveLength(1);
      expect((writes[0] as SettingsPatchBody).publication?.tagline).toBe("Owls & more");
      expect(bar().classList.contains("show")).toBe(false);
      expect($("#toasts").textContent).toMatch(/Settings saved/);
    });

    it("says a refused ⌘S in the bar, as Save changes does, keeping the edit unsaved", async () => {
      await open("#/settings", refused);
      typeInto(tagline(), "Owls & more");
      pressSave();
      await settle();
      expect(bar().classList.contains("is-error")).toBe(true);
      expect($(".savebar-msg").textContent).toMatch(/Database unavailable/);
      expect(unloadCancelled()).toBe(true);
    });

    it("waits for a save under way instead of asking, then goes where the reader was going", async () => {
      const held = heldPut((req) => saved(req.json() as SettingsPatchBody));
      await open("#/settings", held.route);
      typeInto(tagline(), "Owls & more");
      $("#savebarSave").click();
      await settle();
      await at("#/subscribers");
      expect(confirm).not.toHaveBeenCalled();
      expect(location.hash).toBe("#/settings");
      expect(h1()).toBe("Settings");
      held.release();
      await settle();
      hashchange();
      await settle();
      expect(location.hash).toBe("#/subscribers");
      expect(h1()).toBe("Subscribers");
      expect(confirm).not.toHaveBeenCalled();
    });

    it("stays with the edit when a save under way is refused, the bar saying why", async () => {
      const held = heldPut(() =>
        jsonResponse({ error: "internal_error", message: "Database unavailable" }, 500),
      );
      await open("#/settings", held.route);
      typeInto(tagline(), "Owls & more");
      $("#savebarSave").click();
      await settle();
      await at("#/subscribers");
      held.release();
      await settle();
      hashchange();
      await settle();
      expect(location.hash).toBe("#/settings");
      expect(h1()).toBe("Settings");
      expect(tagline().value).toBe("Owls & more");
      expect($(".savebar-msg").textContent).toMatch(/Database unavailable/);
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe("Template", () => {
    const editor = () => $<HTMLTextAreaElement>("#tplEditor");
    const edit = () => typeInto(editor(), `${editor().value}<p>signed</p>`);

    it("asks before leaving with an edit, keeps the page and the edit on No, and leaves on Yes", async () => {
      await open("#/template");
      edit();
      const edited = editor().value;
      await at("#/subscribers");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(location.hash).toBe("#/template");
      expect(h1()).toBe("Email template");
      expect(editor().value).toBe(edited);
      confirm.mockReturnValue(true);
      await at("#/subscribers");
      expect(h1()).toBe("Subscribers");
      expect(fake.unhandled).toEqual([]);
    });

    it("leaves a clean page unasked", async () => {
      await open("#/template");
      await at("#/subscribers");
      expect(confirm).not.toHaveBeenCalled();
      expect(h1()).toBe("Subscribers");
    });

    it("has the browser warn on unload only while an edit is unsaved", async () => {
      await open("#/template");
      expect(unloadCancelled()).toBe(false);
      edit();
      expect(unloadCancelled()).toBe(true);
      $("#savebarDiscard").click();
      expect(unloadCancelled()).toBe(false);
    });

    it("is clean after Save changes or Discard, so a leave doesn't ask", async () => {
      await open("#/template");
      edit();
      $("#savebarSave").click();
      await settle();
      expect(unloadCancelled()).toBe(false);
      edit();
      $("#savebarDiscard").click();
      await at("#/subscribers");
      expect(confirm).not.toHaveBeenCalled();
      expect(h1()).toBe("Subscribers");
    });

    it("saves on ⌘S exactly as Save changes does, and does nothing on a clean page", async () => {
      await open("#/template");
      pressSave();
      expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
      edit();
      const edited = editor().value;
      pressSave();
      await settle();
      expect(fake.calls.filter((c) => c.method === "PUT").map((c) => c.json())).toEqual([
        { email_template: edited },
      ]);
      expect(bar().classList.contains("show")).toBe(false);
      expect($("#toasts").textContent).toMatch(/Template saved/);
    });

    it("waits for a save under way instead of asking, then goes where the reader was going", async () => {
      const held = heldPut((req) => saved(req.json() as SettingsPatchBody));
      await open("#/template", held.route);
      edit();
      $("#savebarSave").click();
      await settle();
      await at("#/subscribers");
      expect(confirm).not.toHaveBeenCalled();
      expect(h1()).toBe("Email template");
      held.release();
      await settle();
      hashchange();
      await settle();
      expect(h1()).toBe("Subscribers");
      expect(confirm).not.toHaveBeenCalled();
    });
  });
});
