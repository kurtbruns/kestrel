// The post's latest render, kept ahead of the publisher: the server's render of a saved
// revision (the one render path, I5), fetched once per revision and held so the Preview tab can
// show it the moment it is opened. A render is keyed to the revision that was saved when it was
// asked for. The preview routes render whatever is saved when they answer, so a render that a
// write (a save, an upload) overlapped can't be tied to any one revision, and is dropped rather
// than held under the wrong key. Anything else that wants the post's current render (a count
// of its warnings, say) reads it here rather than asking the server again.

/** One render of the post: the email as a page, and what the render found wrong with it. */
export interface Render {
  /** The saved revision this is the render of. */
  revision: string;
  html: string;
  warnings: string[];
}

/** Fetch the post's render as the server holds it now. */
export type FetchRender = () => Promise<Omit<Render, "revision">>;

export class LatestRender {
  private held: Render | null = null;
  private inFlight: { revision: string; promise: Promise<Render | null> } | null = null;
  // Bumped by every write to the post, so a render that overlapped one is known not to match.
  private generation = 0;

  constructor(private readonly fetchRender: FetchRender) {}

  /** The newest render held, of whichever revision: what the Preview tab last could show. */
  get latest(): Render | null {
    return this.held;
  }

  /**
   * The render of `revision`: the one held, the one already in flight, or a new fetch.
   * Resolves null when a write landed while it was in flight, since what came back can't be
   * tied to `revision`; the caller asks again once the post is still. Rejects as the request did.
   */
  want(revision: string): Promise<Render | null> {
    if (this.held?.revision === revision) {
      return Promise.resolve(this.held);
    }
    if (this.inFlight?.revision === revision) {
      return this.inFlight.promise;
    }
    const generation = this.generation;
    const promise = this.fetchRender().then(
      ({ html, warnings }) => {
        if (this.inFlight?.promise === promise) {
          this.inFlight = null;
        }
        if (generation !== this.generation) {
          return null;
        }
        const render: Render = { revision, html, warnings };
        this.held = render;
        return render;
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

  /** A write to the post is starting: a new revision is coming, so a render in flight may
   *  straddle it. What is held stays, still the render of its own revision. */
  writing(): void {
    this.generation += 1;
    this.inFlight = null;
  }

  /** The render changed without a new revision (an image the text names was uploaded or
   *  removed), so nothing held or in flight is the render of its revision any more. */
  forget(): void {
    this.writing();
    this.held = null;
  }
}
