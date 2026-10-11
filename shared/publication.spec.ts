import { describe, expect, it } from "vitest";
import { fromDisplayName, publicationName } from "./publication";

describe("fromDisplayName (SPEC §9)", () => {
  it.each([
    ["a quoted name", '"Birds Weekly" <hello@birds.example>', "Birds Weekly"],
    ["an unquoted name", "Birds Weekly <hello@birds.example>", "Birds Weekly"],
    ["a quoted name with a comma", '"Smith, Jane" <jane@birds.example>', "Smith, Jane"],
    ["a quoted name with escaped quotes", '"The \\"Birds\\"" <a@b.c>', 'The "Birds"'],
    ["surrounding whitespace", '  "Birds"   <a@b.c>  ', "Birds"],
    ["a bare address", "hello@birds.example", ""],
    ["an address in angle brackets alone", "<hello@birds.example>", ""],
    ["an empty quoted name", '"" <hello@birds.example>', ""],
    ["an empty header", "", ""],
  ])("reads %s", (_shape, header, name) => {
    expect(fromDisplayName(header)).toBe(name);
  });
});

describe("publicationName (SPEC §9)", () => {
  it("is the publisher's name when one is set", () => {
    expect(publicationName("Birds Weekly", "Other <a@b.c>")).toBe("Birds Weekly");
  });

  it("falls back to the sender's display name", () => {
    expect(publicationName("", '"Birds" <a@b.c>')).toBe("Birds");
  });

  it("is empty, never a made-up name, when neither is set", () => {
    expect(publicationName("", "a@b.c")).toBe("");
    expect(publicationName("", "<a@b.c>")).toBe("");
  });
});
