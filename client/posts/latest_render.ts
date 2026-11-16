// The post's latest render, kept ahead of the publisher: the server's render of a saved
// revision (the one render path, I5), fetched once per revision and held so the Preview tab can
// show it the moment it is opened. The server names the revision each render is of, so a render
// is held under that revision and no other: one that comes back of a revision other than the one
// asked for (a save, ours or another writer's, landed first) is held as that revision's, ready
// for when the editor catches up to it, and never given to the caller as the one it asked for.
// Anything else that wants the post's current render (a count of its warnings, say) reads it
// here rather than asking the server again.

/** One render of the post: the email as a page, and what the render found wrong with it. */
export interface Render {
  /** The saved revision this is the render of, as the server named it. */
  revision: string;
  html: string;
  warnings: string[];
}

/** Fetch the post's render as the server holds it now, page and warnings from one render. */
export type FetchRender = () => Promise<Render>;

export class LatestRender {
  private held: Render | null = null;
  private inFlight: { revision: string; promise: Promise<Render | null> } | null = null;
  // Each fetch's turn, so an older request answering late is never taken over a newer render.
  private asked = 0;
  private heldTurn = 0;
  // The turn of the last change to the render that left the revision as it was (an upload):
  // a render asked for before it may be of the old images under the same revision.
  private forgotAt = 0;

  constructor(private readonly fetchRender: FetchRender) {}

  /** The newest render held, of whichever revision: what the Preview tab last could show. */
  get latest(): Render | null {
    return this.held;
  }

  /**
   * The render of `revision`: the one held, the one already in flight, or a new fetch.
   * Resolves null when the server's render is of another revision (the post moved on, or hadn't
   * yet reached `revision`), when a render asked for later has already landed, or when the render
   * changed while it was in flight; the caller asks again once the post is still. Rejects as the
   * request did.
   */
  want(revision: string): Promise<Render | null> {
    if (this.held?.revision === revision) {
      return Promise.resolve(this.held);
    }
    if (this.inFlight?.revision === revision) {
      return this.inFlight.promise;
    }
    const turn = ++this.asked;
    const promise = this.fetchRender().then(
      (render) => {
        if (this.inFlight?.promise === promise) {
          this.inFlight = null;
        }
        // Older than what is held, or than a change to the render: a later answer has it.
        if (turn < this.heldTurn || turn <= this.forgotAt) {
          return null;
        }
        this.held = render;
        this.heldTurn = turn;
        return render.revision === revision ? render : null;
      },
      (e: unknown) => {
        if (this.inFlight?.promise === promise) {
          this.inFlight = null;
        }
        throw e;
      },
    );
    this.inFlight = { revision, promise };
    return promise;
  }

  /** The render changed without a new revision (an image the text names was uploaded or
   *  removed), so nothing held or in flight is the render of its revision any more. */
  forget(): void {
    this.forgotAt = this.asked;
    this.inFlight = null;
    this.held = null;
  }
}
