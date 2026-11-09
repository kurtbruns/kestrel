import { describe, expect, it } from "vitest";
import {
  fromAddressOnly,
  fromDisplayName,
  fromHeader,
  notificationSender,
  sender,
  senderName,
} from "./publication";

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

describe("fromAddressOnly", () => {
  it.each([
    ["a named header", "Birds Weekly <hello@birds.example>", "hello@birds.example"],
    [
      "a quoted name with a bracket in it",
      '"<Birds>" <hello@birds.example>',
      "hello@birds.example",
    ],
    ["a bare address", "  hello@birds.example ", "hello@birds.example"],
    ["brackets alone", "<hello@birds.example>", "hello@birds.example"],
  ])("is the address of %s", (_shape, header, address) => {
    expect(fromAddressOnly(header)).toBe(address);
  });
});

describe("senderName (SPEC §9)", () => {
  it("follows the publication name when the From address is bare", () => {
    expect(senderName("Birds Weekly", "hello@birds.example")).toBe("Birds Weekly");
    expect(senderName("Birds Weekly", "<hello@birds.example>")).toBe("Birds Weekly");
  });

  it("is a name written into the From address, over the publication name", () => {
    expect(senderName("Birds Weekly", "Jane <hello@birds.example>")).toBe("Jane");
    expect(senderName("", '"Jane" <hello@birds.example>')).toBe("Jane");
  });

  it("is empty, never a made-up name, with a bare address and no publication name", () => {
    expect(senderName("", "hello@birds.example")).toBe("");
  });

  it("gives the sender as name and address", () => {
    expect(sender("Birds Weekly", "hello@birds.example")).toEqual({
      name: "Birds Weekly",
      address: "hello@birds.example",
    });
    expect(sender("Birds Weekly", "Jane <hello@birds.example>")).toEqual({
      name: "Jane",
      address: "hello@birds.example",
    });
  });
});

describe("fromHeader (SPEC §9)", () => {
  const at = "hello@birds.example";

  it("is the address alone without a name", () => {
    expect(fromHeader({ name: "", address: at })).toBe(at);
    expect(fromHeader({ name: "   ", address: at })).toBe(at);
  });

  it("carries a plain name as it is", () => {
    expect(fromHeader({ name: "Birds Weekly", address: at })).toBe(`Birds Weekly <${at}>`);
    expect(fromHeader({ name: "Kurt's Notes", address: at })).toBe(`Kurt's Notes <${at}>`);
  });

  it.each([
    ["a comma", "Smith, Jane", '"Smith, Jane"'],
    ["a period", "Birds Weekly Inc.", '"Birds Weekly Inc."'],
    ["a colon", "Birds: Weekly", '"Birds: Weekly"'],
    ["angle brackets", "Birds <Weekly>", '"Birds <Weekly>"'],
    ["an at sign", "birds@weekly", '"birds@weekly"'],
    ["parentheses", "Birds (Weekly)", '"Birds (Weekly)"'],
    ["a quote, escaped", 'The "Birds"', '"The \\"Birds\\""'],
    ["a backslash, escaped", "Birds \\ Weekly", '"Birds \\\\ Weekly"'],
  ])("quotes a name with %s, so it can't read as two addresses", (_what, name, quoted) => {
    expect(fromHeader({ name, address: at })).toBe(`${quoted} <${at}>`);
  });

  it("drops control characters and collapses whitespace, so a name can't end the header or add one", () => {
    expect(fromHeader({ name: "Birds\r\nBcc: x@y.z", address: at })).toBe(
      `"BirdsBcc: x@y.z" <${at}>`,
    );
    expect(fromHeader({ name: "Birds\u0000 \t Weekly\u0085", address: at })).toBe(
      `Birds Weekly <${at}>`,
    );
    expect(fromHeader({ name: "Birds", address: `${at}\n` })).toBe(`Birds <${at}>`);
  });

  const decoded = (header: string) =>
    [...header.matchAll(/=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/g)]
      .map((m) =>
        new TextDecoder().decode(Uint8Array.from(atob(m[1] ?? ""), (c) => c.charCodeAt(0))),
      )
      .join("");
  const words = (header: string) => header.slice(0, header.lastIndexOf(" <")).split(" ");

  it("encodes a name with characters outside ASCII as an RFC 2047 encoded-word, never quoted", () => {
    const header = fromHeader({ name: "Café, Notes", address: at });
    expect(header).toBe(`=?utf-8?B?Q2Fmw6ksIE5vdGVz?= <${at}>`);
    expect(decoded(header)).toBe("Café, Notes");
  });

  it("splits a long non-ASCII name into encoded-words of at most 75 characters, between characters", () => {
    // 60 two-byte characters: 120 bytes, which no one encoded-word may carry.
    const name = "ÄÖÜ".repeat(20);
    const header = fromHeader({ name, address: at });
    const ws = words(header);
    expect(ws).toHaveLength(3);
    for (const w of ws) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(w).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
    expect(decoded(header)).toBe(name);
    expect(header.endsWith(` <${at}>`)).toBe(true);
  });

  it("never cuts a character's bytes across two encoded-words", () => {
    // 44 ASCII bytes, then a four-byte character: it moves whole to the next word.
    const name = `${"a".repeat(44)}😀b`;
    const header = fromHeader({ name, address: at });
    expect(words(header)).toHaveLength(2);
    expect(decoded(header)).toBe(name);
  });
});

describe("notificationSender (SPEC §8)", () => {
  it("is Kestrel until the publication has a name, then '<name> via Kestrel'", () => {
    expect(notificationSender("", "news@send.birds.example")).toEqual({
      name: "Kestrel",
      address: "news@send.birds.example",
    });
    expect(notificationSender("  ", "news@send.birds.example").name).toBe("Kestrel");
    expect(notificationSender(" Field Notes ", "news@send.birds.example").name).toBe(
      "Field Notes via Kestrel",
    );
  });

  it("takes the address of FROM_ADDRESS and never the name written there", () => {
    expect(notificationSender("Field Notes", "Field Desk <news@send.birds.example>")).toEqual({
      name: "Field Notes via Kestrel",
      address: "news@send.birds.example",
    });
    expect(notificationSender("", "Field Desk <news@send.birds.example>").name).toBe("Kestrel");
  });

  it("is quoted in the header when the name needs it, so SES takes it", () => {
    expect(fromHeader(notificationSender("Birds, Weekly", "news@send.birds.example"))).toBe(
      '"Birds, Weekly via Kestrel" <news@send.birds.example>',
    );
  });
});
