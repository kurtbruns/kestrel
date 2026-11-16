import { describe, expect, it } from "vitest";
import { LatestRender, type Render } from "./latest_render";

/** A render source over a fake server whose answers the spec releases one at a time, each naming
 *  the revision the server rendered. */
function source() {
  const pending: Array<(revision: string, page: string) => void> = [];
  let fails: Error | null = null;
  const renders = new LatestRender(
    () =>
      new Promise((resolve, reject) => {
        if (fails) {
          reject(fails);
          return;
        }
        pending.push((revision, page) =>
          resolve({ revision, html: page, warnings: [`about ${page}`] }),
        );
      }),
  );
  return {
    renders,
    /** Requests made so far. */
    asked: () => pending.length,
    /** Answer request `n` (0-based) with the render of `revision`. */
    answer: (n: number, revision: string, page: string) => pending[n]!(revision, page),
    failWith: (e: Error) => {
      fails = e;
    },
  };
}

describe("the post's latest render", () => {
  it("asks the server once for a revision, however many want it at once", async () => {
    const s = source();
    const a = s.renders.want("r2");
    const b = s.renders.want("r2");
    expect(s.asked()).toBe(1);
    s.answer(0, "r2", "<p>two</p>");
    const want: Render = { revision: "r2", html: "<p>two</p>", warnings: ["about <p>two</p>"] };
    expect(await a).toEqual(want);
    expect(await b).toEqual(want);
    expect(s.renders.latest).toEqual(want);
    // Held now, so a later want for it asks nothing.
    expect(await s.renders.want("r2")).toEqual(want);
    expect(s.asked()).toBe(1);
  });

  it("never answers a want with a render the server says is of another revision", async () => {
    const s = source();
    const before = s.renders.want("r2");
    s.answer(0, "r3", "<p>three</p>"); // another save landed before the render read the post
    expect(await before).toBe(null);
    // Asked again, it is fetched afresh.
    const again = s.renders.want("r2");
    expect(s.asked()).toBe(2);
    s.answer(1, "r2", "<p>two</p>");
    expect((await again)?.html).toBe("<p>two</p>");
  });

  it("holds a render of another revision as that revision's, so it is ready when the editor reaches it", async () => {
    const s = source();
    const before = s.renders.want("r2");
    s.answer(0, "r3", "<p>three</p>");
    await before;
    expect(s.renders.latest?.revision).toBe("r3");
    expect((await s.renders.want("r3"))?.html).toBe("<p>three</p>");
    expect(s.asked()).toBe(1);
  });

  it("drops an older request's answer that lands after a newer render, never handing it back to be shown", async () => {
    const s = source();
    const older = s.renders.want("r2");
    const newer = s.renders.want("r3");
    s.answer(1, "r3", "<p>three</p>");
    await newer;
    s.answer(0, "r2", "<p>two</p>");
    expect(await older).toBe(null);
    expect(s.renders.latest?.revision).toBe("r3");
  });

  it("forgets what it holds when the render changes without a new revision (an image uploaded)", async () => {
    const s = source();
    const first = s.renders.want("r2");
    s.answer(0, "r2", "<p>broken image</p>");
    await first;
    s.renders.forget();
    expect(s.renders.latest).toBe(null);
    const again = s.renders.want("r2");
    expect(s.asked()).toBe(2);
    s.answer(1, "r2", "<p>image</p>");
    expect((await again)?.html).toBe("<p>image</p>");
  });

  it("drops a render asked for before an upload, of the same revision but maybe the old images", async () => {
    const s = source();
    const before = s.renders.want("r2");
    s.renders.forget();
    s.answer(0, "r2", "<p>broken image</p>");
    expect(await before).toBe(null);
    expect(s.renders.latest).toBe(null);
  });

  it("passes a failed request on, and asks afresh the next time", async () => {
    const s = source();
    s.failWith(new Error("The render failed."));
    await expect(s.renders.want("r2")).rejects.toThrow("The render failed.");
    expect(s.renders.latest).toBe(null);
    await expect(s.renders.want("r2")).rejects.toThrow("The render failed.");
  });
});
