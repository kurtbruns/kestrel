// A post's settings as every surface words and edits them (SPEC §4, §5): whether it is
// included in the archive, and its archive address. Post settings, Schedule, Send now,
// Edit schedule, and Add to archive edit a working copy through the same form, which reaches the
// post only when the publisher presses that dialog's act, and show a refused address under its
// field. One module, so the choice reads the same everywhere (DESIGN §3).

import type { Post, PostSettingsBody } from "../../shared/posts";
import { slugify } from "../../shared/slug";
import { ApiError } from "../api";
import { postArchiveUrl } from "../deployment";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";

/** An address as the app shows it: without its scheme, which says nothing to a publisher. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** The archive's base as the address field shows it before the slug (`host/archive/`). */
export function archiveBase(): string {
  const url = postArchiveUrl("");
  return url ? shortUrl(url) : "/archive/";
}

/**
 * A post's settings, as stored or as a dialog's working copy. `fixed` once the post is
 * published (its send has started), when its address can no longer change. `slugTaken`, from the server: the slug the
 * subject gives when another post holds it, so the address didn't follow the subject.
 */
export interface Publishing {
  emailOnly: boolean;
  slug: string;
  slugAuto: boolean;
  subject: string;
  slugTaken: string | null;
  fixed: boolean;
}

/** A post's settings as the server answered them. */
export function publishingOf(post: Post, slugTaken: string | null): Publishing {
  return {
    emailOnly: post.email_only,
    slug: post.slug,
    slugAuto: post.slug_auto,
    subject: post.subject,
    slugTaken,
    // Fixed once the send starts, while `status` still reads scheduled (SPEC §4).
    fixed: post.published_at !== null,
  };
}

/**
 * What a scheduled post's send will do, for its banner's bottom row: email it and publish it at
 * its archive address, or email it only. In the top row's own tense ("Sends in 2 days").
 */
export function destinationHtml(p: Publishing): Html {
  return p.emailOnly
    ? html`Sends by email only`
    : html`Sends by email and publishes at <code>${archiveBase()}${p.slug}</code>`;
}

/** The icon beside a scheduled post's destination: a link to its archive page, or an envelope
 *  for a post that goes only by email. */
export function destinationIcon(p: Publishing): Html {
  return icon(p.emailOnly ? "mail" : "link");
}

/** The helper under Include in archive, in every dialog that shows the box. */
const INCLUDE_HELP =
  "Listed on your home page and in your public archive. Unchecked, it’s sent as email only: anyone with the email can still open its web version.";

/** What a fixed address says under it, unless a surface says otherwise. */
const FIXED_NOTE = "Fixed once the post is sent, since people may have its link.";

/** What the address says under it: that it is fixed, that the subject's slug is another
 *  post's, or that it follows the subject. */
function addressNoteHtml(p: Publishing, fixedNote: string): Html | null {
  if (p.fixed) {
    return html`<p class="pub-note">${fixedNote}</p>`;
  }
  if (p.slugAuto && p.slugTaken) {
    return html`<p class="pub-taken">${icon("info")}<span>Another post has <code>${p.slugTaken}</code>, so a number was added. You can change it above.</span></p>`;
  }
  return p.slugAuto
    ? html`<p class="pub-note">Follows the subject until you type your own.</p>`
    : null;
}

/** How a settings form is drawn: with or without the Include in archive box (Add to archive is
 *  itself that choice), the words under a fixed address, and what follows a change. */
export interface SettingsFormOptions {
  include?: boolean;
  fixedNote?: string;
  /** Called after each change to the working copy, for a line that says where it will go. */
  onChange?: () => void;
}

/**
 * The settings as a form over `p` (DESIGN §3): Include in archive and, while it is checked, the
 * archive address as one URL field, its base fixed and greyed and only the slug editable after
 * it. `prefix` names the inputs (`<prefix>Include`, `<prefix>Slug`) and the line under the field
 * (`<prefix>Note`), so two forms never share an id.
 */
function settingsFormHtml(
  p: Publishing,
  prefix: string,
  { include = true, fixedNote = FIXED_NOTE }: SettingsFormOptions,
): Html {
  const box = include
    ? html`<label class="listing-check"><input type="checkbox" id="${prefix}Include"${p.emailOnly ? null : html` checked`}><span><strong>Include in archive</strong><span class="listing-help">${INCLUDE_HELP}</span></span></label>`
    : null;
  if (p.emailOnly) {
    return html`${box}`;
  }
  return html`${box}<div class="pub-address"><label class="pub-label" for="${prefix}Slug">Archive address</label><label class="url-field${p.fixed ? " readonly" : ""}" id="${prefix}Field"><span class="url-base">${archiveBase()}</span><input type="text" id="${prefix}Slug" value="${p.slug}" spellcheck="false" autocomplete="off" autocapitalize="off"${p.fixed ? html` readonly` : null}></label><div id="${prefix}Note">${addressNoteHtml(p, fixedNote)}</div></div>`;
}

/**
 * Wire a form `settingsFormHtml` drew inside `root` to the working copy `p`. `repaint` redraws
 * the form, for a change that shows or hides a part of it. Focusing the field selects the slug,
 * the one part to type over; typing takes the address by hand, and leaving it empty hands it
 * back to the subject.
 */
function wireSettingsForm(
  root: Element,
  p: Publishing,
  prefix: string,
  repaint: () => void,
  { fixedNote = FIXED_NOTE, onChange }: SettingsFormOptions,
): void {
  const include = root.querySelector<HTMLInputElement>(`#${prefix}Include`);
  if (include) {
    include.onchange = () => {
      p.emailOnly = !include.checked;
      repaint();
      onChange?.();
    };
  }
  const slug = root.querySelector<HTMLInputElement>(`#${prefix}Slug`);
  const note = root.querySelector<HTMLElement>(`#${prefix}Note`);
  if (!slug || !note || p.fixed) {
    return;
  }
  slug.onfocus = () => slug.select();
  slug.oninput = () => {
    p.slug = slug.value;
    p.slugAuto = false;
    root.querySelector(`#${prefix}Field`)?.classList.remove("is-invalid");
    setHtml(note, addressNoteHtml(p, fixedNote) ?? html``);
  };
  slug.onblur = () => {
    if (slug.value.trim() === "") {
      p.slugAuto = true;
      p.slug = slugify(p.subject) || p.slug;
      repaint();
    }
  };
}

/**
 * What a working copy changes about the stored settings, as `PUT /api/posts/:id/settings` (and
 * Schedule, Send now, and Edit schedule) take it, or null when it changes nothing. A fixed address
 * never changes, and one handed back to the subject asks the server to derive it again.
 */
export function settingsChange(saved: Publishing, working: Publishing): PostSettingsBody | null {
  const body: PostSettingsBody = {};
  if (working.emailOnly !== saved.emailOnly) {
    body.email_only = working.emailOnly;
  }
  if (!saved.fixed && !working.emailOnly) {
    if (working.slugAuto && !saved.slugAuto) {
      body.slug_auto = true;
    } else if (!working.slugAuto && working.slug !== saved.slug) {
      body.slug = working.slug;
    }
  }
  return Object.keys(body).length ? body : null;
}

/**
 * Draw the settings form into `el` over the working copy `p`, and keep it wired: each change
 * that shows or hides a part redraws it. For a dialog that holds the form beside other fields.
 */
export function mountSettingsForm(
  el: HTMLElement,
  p: Publishing,
  prefix: string,
  options: SettingsFormOptions = {},
): void {
  const paint = () => {
    setHtml(el, settingsFormHtml(p, prefix, options));
    wireSettingsForm(el, p, prefix, paint, options);
  };
  paint();
}

/**
 * Show a refused address (`slug_invalid`, `slug_taken`, `slug_permanent`) under the form's field
 * in the server's words, and focus it. False for any other failure, which the dialog says as
 * it says any error.
 */
export function showSlugRefusal(root: Element, prefix: string, e: unknown): boolean {
  if (!(e instanceof ApiError) || (e.field !== "slug" && e.field !== "slug_auto")) {
    return false;
  }
  const note = root.querySelector<HTMLElement>(`#${prefix}Note`);
  const slug = root.querySelector<HTMLInputElement>(`#${prefix}Slug`);
  if (!note || !slug) {
    return false;
  }
  root.querySelector(`#${prefix}Field`)?.classList.add("is-invalid");
  setHtml(note, html`<p class="pub-error" role="alert">${e.message}</p>`);
  slug.focus();
  return true;
}
