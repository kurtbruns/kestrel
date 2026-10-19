import { describe, expect, it } from "vitest";
import type { ImportRecord } from "../../shared/imports";
import { evidenceText, importedBy, joinedVia, originName } from "./provenance";

describe("joinedVia", () => {
  it("reads an imported subscriber by the import, with the origin and method the file claimed (SPEC §7)", () => {
    expect(joinedVia({ import_id: "i1", origin: "sendy", opt_in: "single", confirmed_at: 1 })).toBe(
      "Imported · Sendy, single opt-in",
    );
    expect(
      joinedVia({ import_id: "i1", origin: "unknown", opt_in: "unknown", confirmed_at: 1 }),
    ).toBe("Imported · opt-in unknown");
  });

  it("never reads a file's claim of this app's double opt-in as this app's", () => {
    expect(
      joinedVia({ import_id: "i1", origin: "kestrel", opt_in: "double", confirmed_at: 1 }),
    ).toBe("Imported · Kestrel, double opt-in");
  });

  it("reads a confirmation recorded here as double opt-in, and says nothing before one", () => {
    expect(
      joinedVia({ import_id: null, origin: "kestrel", opt_in: "double", confirmed_at: 5 }),
    ).toBe("Double opt-in");
    expect(
      joinedVia({ import_id: null, origin: "kestrel", opt_in: "double", confirmed_at: null }),
    ).toBeNull();
  });
});

describe("originName", () => {
  it("names a known service as it spells itself, and raises the first letter of any other", () => {
    expect(originName("mailchimp")).toBe("Mailchimp");
    expect(originName("convertkit")).toBe("ConvertKit");
    expect(originName("tinyletter")).toBe("Tinyletter");
    expect(originName("unknown")).toBeNull();
  });
});

describe("evidenceText", () => {
  it("pretty-prints JSON evidence, keeps anything else as it is, and has none for none", () => {
    expect(evidenceText('{"signup_ip":"203.0.113.7"}')).toBe('{\n  "signup_ip": "203.0.113.7"\n}');
    expect(evidenceText("not json")).toBe("not json");
    expect(evidenceText(null)).toBeNull();
  });
});

describe("importedBy", () => {
  const record = (principal: ImportRecord["principal"]) => ({ principal }) as ImportRecord;

  it("reads a service token's import as automation's, never a person's (SPEC §11)", () => {
    expect(importedBy(record({ kind: "service", email: null, client: null }))).toBe(
      "a service token",
    );
  });

  it("reads a person's import by their address, with the client when it wasn't the editor (SPEC §11)", () => {
    expect(importedBy(record({ kind: "human", email: "you@example.com", client: "editor" }))).toBe(
      "you@example.com",
    );
    expect(
      importedBy(record({ kind: "human", email: "you@example.com", client: "claude-code" })),
    ).toBe("you@example.com via Claude Code");
    expect(importedBy(record({ kind: "human", email: "you@example.com", client: null }))).toBe(
      "you@example.com via the API",
    );
  });
});
