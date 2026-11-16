import { describe, expect, it } from "vitest";
import { DirtyTracker } from "./dirty";

describe("DirtyTracker", () => {
  it("is clean at first, dirty once a field differs, clean again when marked saved", () => {
    const fields = { subject: "a", body: "b" };
    const d = new DirtyTracker(() => fields);
    expect(d.dirty).toBe(false);
    fields.body = "bb";
    expect(d.dirty).toBe(true);
    d.markSaved();
    expect(d.dirty).toBe(false);
  });

  it("marking what was sent leaves an edit typed during the save dirty", () => {
    const fields = { body: "draft" };
    const d = new DirtyTracker(() => fields);
    fields.body = "draft 1";
    const sent = d.snapshot(); // the save's payload
    fields.body = "draft 12"; // typed while the save was in flight
    d.markSaved(sent);
    expect(d.dirty).toBe(true);
    d.markSaved();
    expect(d.dirty).toBe(false);
  });

  it("is dirty once marked unsaved, even with no field changed, until a save lands", () => {
    const fields = { subject: "a", body: "b" };
    const d = new DirtyTracker(() => fields);
    d.markUnsaved();
    expect(d.dirty).toBe(true);
    fields.body = "bb";
    fields.body = "b"; // back to what was ours: still not what the server holds
    expect(d.dirty).toBe(true);
    d.markSaved(d.snapshot());
    expect(d.dirty).toBe(false);
  });
});
