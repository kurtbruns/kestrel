import { describe, expect, it } from "vitest";
import { Html, html } from "./html";
import { type IconName, icon, isIconName } from "./icons";

// Every registered name. `satisfies` makes the compiler hold this to the registry: a name
// added there and not here, or one here that is not there, fails the typecheck.
const ALL = {
  article: true,
  bold: true,
  check: true,
  code: true,
  copyout: true,
  editable: true,
  heading: true,
  indent: true,
  info: true,
  "info-filled": true,
  italic: true,
  kestrel: true,
  lines: true,
  link: true,
  ol: true,
  paperclip: true,
  plus: true,
  preview: true,
  quote: true,
  readonly: true,
  search: true,
  send: true,
  ul: true,
  upload: true,
  x: true,
  book: true,
  branch: true,
  "circle-check": true,
  "circle-minus": true,
  desktop: true,
  mail: true,
  phone: true,
} as const satisfies Record<IconName, true>;
const names = Object.keys(ALL) as IconName[];

describe("icons", () => {
  it.each(names)("serves %s as one inline, decorative, self-sizing drawing", (name) => {
    expect(isIconName(name)).toBe(true);
    const m = icon(name);
    expect(m).toBeInstanceOf(Html);
    const open = /^<svg ([^>]*)>/.exec(m.markup)?.[1] ?? "";
    expect(open).toMatch(/^xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(open).toMatch(/\baria-hidden="true"/);
    expect(open).toMatch(/\bviewBox="-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+"/);
    expect(m.markup.trimEnd()).toMatch(/<\/svg>$/);
    expect(m.markup.match(/<svg[\s>]/g)).toHaveLength(1);
  });

  it("composes into the html tag without escaping", () => {
    expect(html`<button>${icon("x")}</button>`.markup).toMatch(/^<button><svg /);
  });

  it("names its icons", () => {
    expect(isIconName("bold")).toBe(true);
    expect(isIconName("toString")).toBe(false);
    expect(isIconName("nope")).toBe(false);
  });
});
