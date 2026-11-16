// Optimistic concurrency on the client (SPEC §4): the revision this editor is based on,
// and what a failed save or a freshness poll means against it. The server rejects a save
// whose base is not the newest revision (409) rather than clobber another writer's. With
// nothing unsaved here the editor takes the newer version in, since no one's words are at
// stake; with something unsaved it tells the publisher, and never decides for them.

import { ApiError } from "../api";

/** Who wrote a revision: a person's email, "service" for a service token (automation), or unknown. */
export type Author = string | null;

/** What the editor must surface: another writer's newer revision, with who wrote it and the
 *  client they came through (SPEC §11), or a post no longer editable here. */
export type Conflict =
  | { kind: "stale"; revision: string; author: Author; client: string | null }
  | { kind: "locked" };

/** Classify a failed save; null when it is a plain failure, not a conflict. */
export function conflictFromError(e: unknown): Conflict | null {
  if (!(e instanceof ApiError) || e.status !== 409) {
    return null;
  }
  const d = e.data as {
    error?: unknown;
    current_revision?: unknown;
    author?: unknown;
    author_client?: unknown;
  } | null;
  if (d?.error === "stale_revision" && typeof d.current_revision === "string") {
    return {
      kind: "stale",
      revision: d.current_revision,
      author: typeof d.author === "string" ? d.author : null,
      client: typeof d.author_client === "string" ? d.author_client : null,
    };
  }
  return { kind: "locked" };
}

/** A freshness poll's answer: the post's status and newest revision, and who wrote it. */
export interface PollAnswer {
  status: string;
  revision: string | null;
  author: Author;
  client: string | null;
}

/** What was true when the poll was sent, to tell our own save's effect from another writer's. */
export interface PollContext {
  saving: boolean;
  baseAtRequest: string | null;
}

export class RevisionTracker {
  /** The revision this editor is based on; carried on every save so the server can refuse a stale one. */
  base: string | null;
  /** The newest revision already surfaced, so the poll re-warns only on a genuinely newer one. */
  warnedRevision: string | null = null;

  constructor(base: string | null) {
    this.base = base;
  }

  /** Our save landed: it is the newest revision, so the poll compares against it. */
  saved(revision: string | null): void {
    this.base = revision;
  }

  /** A conflict was shown; a stale one is remembered so the poll does not repeat it. */
  noteWarned(conflict: Conflict): void {
    if (conflict.kind === "stale") {
      this.warnedRevision = conflict.revision;
    }
  }

  /** The publisher chose to keep editing: adopt the newer revision as the base, so the next save wins. */
  adoptWarned(): void {
    if (this.warnedRevision !== null) {
      this.base = this.warnedRevision;
    }
    this.warnedRevision = null;
  }

  /** Another writer's revision was taken into an editor with nothing unsaved: it is the base now. */
  took(revision: string): void {
    this.base = revision;
    this.warnedRevision = null;
  }

  clearWarning(): void {
    this.warnedRevision = null;
  }

  /**
   * What a poll's answer means. "ignore" when our own save moved the base while the poll
   * was in flight (the answer may predate it) or a save is running now; "locked" when the
   * post is no longer a draft; a stale conflict when there is a newer revision not yet
   * surfaced; "fresh" otherwise.
   */
  decide(answer: PollAnswer, at: PollContext): Conflict | "ignore" | "fresh" {
    if (at.saving || this.base !== at.baseAtRequest) {
      return "ignore";
    }
    if (answer.status !== "draft") {
      return { kind: "locked" };
    }
    const rev = answer.revision;
    if (rev && rev !== this.base && rev !== this.warnedRevision) {
      return { kind: "stale", revision: rev, author: answer.author, client: answer.client };
    }
    return "fresh";
  }
}

/** What the editor's state is when another writer's newer revision is found. */
export interface NewerContext {
  /** Anything on screen the server doesn't hold: an edit, or an image still uploading. */
  unsaved: boolean;
  /** An input method is mid-composition, so the text on screen isn't settled yet. */
  composing: boolean;
}

/**
 * What to do about another writer's newer revision (SPEC §4). "take" when nothing here is
 * unsaved: their version replaces the text on screen, since keeping ours would lose nothing
 * and overwriting theirs would lose their words. "later" while a composition is unsettled:
 * look again on the next read, by which time it has become an edit or nothing. "banner"
 * when something here is unsaved: both versions hold words, so the publisher chooses.
 */
export function answerNewer(at: NewerContext): "take" | "later" | "banner" {
  if (at.unsaved) {
    return "banner";
  }
  return at.composing ? "later" : "take";
}
