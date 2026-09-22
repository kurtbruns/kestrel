import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { conflictFromError, RevisionTracker } from "./revisions";

describe("conflictFromError", () => {
  it("reads a stale-revision 409 into who and what", () => {
    const e = new ApiError("changed", 409, {
      error: "stale_revision",
      current_revision: "r7",
      author: "service",
    });
    expect(conflictFromError(e)).toEqual({ kind: "stale", revision: "r7", author: "service" });
  });

  it("treats any other 409 as the post no longer being editable here", () => {
    expect(conflictFromError(new ApiError("not a draft", 409, { error: "not_draft" }))).toEqual({
      kind: "locked",
    });
  });

  it("is null for a plain failure", () => {
    expect(conflictFromError(new ApiError("down", 500))).toBeNull();
    expect(conflictFromError(new Error("network"))).toBeNull();
  });
});

describe("RevisionTracker", () => {
  const draft = (revision: string, author: string | null = "a@b.c") => ({
    status: "draft",
    revision,
    author,
  });

  it("is fresh while the newest revision is our own base", () => {
    const t = new RevisionTracker("r1");
    expect(t.decide(draft("r1"), { saving: false, baseAtRequest: "r1" })).toBe("fresh");
  });

  it("warns on a newer revision once, then stays quiet about that one", () => {
    const t = new RevisionTracker("r1");
    const c = t.decide(draft("r2", "service"), { saving: false, baseAtRequest: "r1" });
    expect(c).toEqual({ kind: "stale", revision: "r2", author: "service" });
    t.noteWarned(c as { kind: "stale"; revision: string; author: string });
    expect(t.decide(draft("r2"), { saving: false, baseAtRequest: "r1" })).toBe("fresh");
    expect(t.decide(draft("r3"), { saving: false, baseAtRequest: "r1" })).toMatchObject({
      kind: "stale",
      revision: "r3",
    });
  });

  it("ignores an answer that may predate our own save, or arrives mid-save", () => {
    const t = new RevisionTracker("r1");
    t.saved("r2");
    expect(t.decide(draft("r1"), { saving: false, baseAtRequest: "r1" })).toBe("ignore");
    expect(t.decide(draft("r9"), { saving: true, baseAtRequest: "r2" })).toBe("ignore");
  });

  it("reports a post that stopped being a draft as locked", () => {
    const t = new RevisionTracker("r1");
    expect(
      t.decide(
        { status: "scheduled", revision: "r1", author: null },
        { saving: false, baseAtRequest: "r1" },
      ),
    ).toEqual({ kind: "locked" });
  });

  it("keep editing adopts the newer revision as the base, so the next save wins", () => {
    const t = new RevisionTracker("r1");
    t.noteWarned({ kind: "stale", revision: "r2", author: null });
    t.adoptWarned();
    expect(t.base).toBe("r2");
    expect(t.warnedRevision).toBeNull();
    expect(t.decide(draft("r2"), { saving: false, baseAtRequest: "r2" })).toBe("fresh");
  });
});
