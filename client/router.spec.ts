import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRouter } from "./router";
import { appState } from "./state";
import { $, type FakeApi, fakeApi, resetShell, settle } from "./test_support";

// The router's listeners are installed once by boot; here once per file, which is what a
// page gets. hashchange is dispatched by hand so the spec does not depend on whether the
// DOM fires it for a scripted `location.hash = …`.
const hashchange = () => window.dispatchEvent(new Event("hashchange"));

describe("router", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    fake = fakeApi([
      { path: "/posts", reply: () => ({ posts: [], page: { total: 0, limit: 50, offset: 0 } }) },
    ]);
  });
  afterEach(() => {
    fake.restore();
    appState.isEditorDirty = false;
    appState.editorSaveFailed = false;
    appState.editorConflict = false;
    appState.editorHash = null;
    appState.editorLeaveFlush = null;
    appState.editorManualSave = null;
    vi.unstubAllGlobals();
  });

  it("installs once, then a hashchange mounts the view the hash names", async () => {
    expect(document.querySelector("#app h1")).toBeNull();
    installRouter();
    location.hash = "#/drafts";
    hashchange();
    await settle();
    expect($("#app h1").textContent).toBe("Drafts");
    expect(fake.unhandled).toEqual([]);
  });

  it("flushes a dirty editor on navigation when its last save succeeded", async () => {
    const flush = vi.fn();
    appState.isEditorDirty = true;
    appState.editorHash = "#/edit/p1";
    appState.editorLeaveFlush = flush;
    location.hash = "#/drafts";
    hashchange();
    await settle();
    expect(flush).toHaveBeenCalledTimes(1);
    expect($("#app h1").textContent).toBe("Drafts");
  });

  it("prompts instead when the last save failed, and a declined prompt restores the editor's hash", async () => {
    // happy-dom has no confirm(); the router calls the global, so stand one in.
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    appState.isEditorDirty = true;
    appState.editorSaveFailed = true;
    appState.editorHash = "#/edit/p1";
    location.hash = "#/drafts";
    hashchange();
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe("#/edit/p1");
    expect(document.querySelector("#app h1")).toBeNull(); // nothing was mounted over the editor
  });

  it("⌘S saves the mounted editor, and is inert elsewhere", () => {
    const save = vi.fn();
    const press = () => {
      const e = new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(press()).toBe(false);
    appState.editorManualSave = save;
    expect(press()).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("asks the browser to prompt before unload only while the editor is dirty", () => {
    const leave = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(leave()).toBe(false);
    appState.isEditorDirty = true;
    expect(leave()).toBe(true);
  });
});
