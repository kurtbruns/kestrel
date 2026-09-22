// Icons as files: client/icons/*.svg, each a complete, viewable SVG that the build imports
// as text and the editor serves inline, so an icon can be opened, previewed, and diffed as
// the drawing it is. One registry, one renderer; the sidebar's static sprite in index.html
// is separate because it paints before any script runs.

import { type Html, unsafeHtml } from "./html";
import article from "./icons/article.svg";
import bold from "./icons/bold.svg";
import check from "./icons/check.svg";
import code from "./icons/code.svg";
import copyout from "./icons/copyout.svg";
import editable from "./icons/editable.svg";
import heading from "./icons/heading.svg";
import indent from "./icons/indent.svg";
import info from "./icons/info.svg";
import infoFilled from "./icons/info-filled.svg";
import italic from "./icons/italic.svg";
import kestrel from "./icons/kestrel.svg";
import lines from "./icons/lines.svg";
import link from "./icons/link.svg";
import ol from "./icons/ol.svg";
import paperclip from "./icons/paperclip.svg";
import preview from "./icons/preview.svg";
import quote from "./icons/quote.svg";
import readonly from "./icons/readonly.svg";
import send from "./icons/send.svg";
import ul from "./icons/ul.svg";
import upload from "./icons/upload.svg";
import x from "./icons/x.svg";

// The files are the app's own drawings, so vouching for them here is the one place icons
// become markup; every other use goes through icon().
const ICONS = {
  article: unsafeHtml(article),
  bold: unsafeHtml(bold),
  check: unsafeHtml(check),
  code: unsafeHtml(code),
  copyout: unsafeHtml(copyout),
  editable: unsafeHtml(editable),
  heading: unsafeHtml(heading),
  indent: unsafeHtml(indent),
  info: unsafeHtml(info),
  "info-filled": unsafeHtml(infoFilled),
  italic: unsafeHtml(italic),
  kestrel: unsafeHtml(kestrel),
  lines: unsafeHtml(lines),
  link: unsafeHtml(link),
  ol: unsafeHtml(ol),
  paperclip: unsafeHtml(paperclip),
  preview: unsafeHtml(preview),
  quote: unsafeHtml(quote),
  readonly: unsafeHtml(readonly),
  send: unsafeHtml(send),
  ul: unsafeHtml(ul),
  upload: unsafeHtml(upload),
  x: unsafeHtml(x),
} as const;

export type IconName = keyof typeof ICONS;

/** Whether a string names an icon; for call sites that pick one by a runtime key. */
export function isIconName(name: string): name is IconName {
  return Object.hasOwn(ICONS, name);
}

/** The inline markup of an icon, decorative (aria-hidden) and sized by its container. */
export function icon(name: IconName): Html {
  return ICONS[name];
}
