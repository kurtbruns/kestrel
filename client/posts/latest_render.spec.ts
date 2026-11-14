import { describe, expect, it } from "vitest";
import { LatestRender, type Render } from "./latest_render";

/** A render source over a fake server whose answers the spec releases one at a time. */
function source() {
  const pending: Array<(page: string) => void> = [];
  let fails: Error | null = null;
  const renders = new LatestRender(
    () =>
      new Promise((resolve, reject) => {
        if (fails) {
          reject(fails);
          return;
        }
        pending.push((page) => resolve({ html: page, warnings: [`about ${page}`] }));
      }),
  );
  return {
    renders,
    /** Requests made so far. */
    asked: () => pending.length,
    /** Answer request `n` (0-based) with `page`. */
    answer: (n: number, page: string) => pending[n]!(page),
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
    s.answer(0, "<p>two</p>");
    const want: Render = { revision: "r2", html: "<p>two</p>", warnings: ["about <p>two</p>"] };
    expect(await a).toEqual(want);
    expect(await b).toEqual(want);
    expect(s.renders.latest).toEqual(want);
    // Held now, so a later want for it asks nothing.
    expect(await s.renders.want("r2")).toEqual(want);
    expect(s.asked()).toBe(1);
  });

  it("drops a render a write overlapped, since it can't say which revision it is of", async () => {
    const s = source();
    const before = s.renders.want("r2");
    s.renders.writing();
    s.answer(0, "<p>two or three</p>");
    expect(await before).toBe(null);
    expect(s.renders.latest).toBe(null);
    // Asked again once the post is still, it is held.
    const after = s.renders.want("r3");
    expect(s.asked()).toBe(2);
    s.answer(1, "<p>three</p>");
    expect((await after)?.revision).toBe("r3");
  });

  it("keeps what it holds across a write, still the render of its own revision", async () => {
    const s = source();
    const first = s.renders.want("r2");
    s.answer(0, "<p>two</p>");
    await first;
    s.renders.writing();
    expect(s.renders.latest?.revision).toBe("r2");
  });

  it("forgets what it holds when the render changes without a new revision (an image uploaded)", async () => {
    const s = source();
    const first = s.renders.want("r2");
    s.answer(0, "<p>broken image</p>");
    await first;
    s.renders.forget();
    expect(s.renders.latest).toBe(null);
    const again = s.renders.want("r2");
    expect(s.asked()).toBe(2);
    s.answer(1, "<p>image</p>");
    expect((await again)?.html).toBe("<p>image</p>");
  });

  it("tells each subscriber of every render as it becomes the latest, until it stops", async () => {
    const s = source();
    const seen: string[] = [];
    const stop = s.renders.subscribe((r) => seen.push(r.revision));
    const a = s.renders.want("r2");
    s.answer(0, "<p>two</p>");
    await a;
    stop();
    const b = s.renders.want("r3");
    s.answer(1, "<p>three</p>");
    await b;
    expect(seen).toEqual(["r2"]);
  });

  it("passes a failed request on, and asks afresh the next time", async () => {
    const s = source();
    s.failWith(new Error("The render failed."));
    await expect(s.renders.want("r2")).rejects.toThrow("The render failed.");
    expect(s.renders.latest).toBe(null);
    await expect(s.renders.want("r2")).rejects.toThrow("The render failed.");
  });
});
