import { describe, expect, it } from "vitest";
import {
  attestationPublication,
  EXPORT_PAGE_ROWS,
  type ExportRow,
  IMPORT_COLUMNS,
  IMPORT_FORMAT,
  type ImportRow,
  mergeRows,
  type ParseResult,
  parseImportFile,
  splitCsv,
  TEMPLATE_CSV,
  TEMPLATE_ROWS,
  TEMPLATE_TXT,
  toImportCsv,
} from "./imports";

const HEADER = "email,status,opt_in,origin";

function rowsOf(result: ParseResult): ImportRow[] {
  if (!result.ok) {
    throw new Error(`refused: ${result.error.message}`);
  }
  return result.file.rows;
}

function errorOf(result: ParseResult) {
  if (result.ok) {
    throw new Error("expected a refusal");
  }
  return result.error;
}

const csv = (text: string) => parseImportFile({ name: "list.csv", text });
const txt = (text: string, status?: "subscribed" | "unsubscribed" | "bounced") =>
  parseImportFile({ name: "list.txt", text }, status);

describe("the CSV format (SPEC §7)", () => {
  it("reads a file without the format column as version 1", () => {
    const rows = rowsOf(csv(`${HEADER}\nAda@Example.com ,subscribed,double,sendy\n`));
    expect(rows).toEqual([
      {
        row: 1,
        email: "ada@example.com",
        valid: true,
        status: "subscribed",
        opt_in: "double",
        origin: "sendy",
        suppression: null,
        subscribed_at: null,
        confirmed_at: null,
        unsubscribed_at: null,
        suppressed_at: null,
        evidence: null,
      },
    ]);
  });

  it("reads a file that names its format, in any column order", () => {
    const rows = rowsOf(
      csv(`format,origin,opt_in,status,email\r\n${IMPORT_FORMAT},sendy,single,pending,a@x.io\r\n`),
    );
    expect(rows.map((r) => [r.email, r.status, r.opt_in])).toEqual([
      ["a@x.io", "pending", "single"],
    ]);
  });

  it("refuses a version it doesn't know, by name", () => {
    const e = errorOf(
      csv(`${HEADER},format\na@x.io,subscribed,double,sendy,kestrel-subscribers/9\n`),
    );
    expect(e.code).toBe("unrecognized_format");
    expect(e.message).toContain("kestrel-subscribers/9");
    expect(e.column).toBe("format");
  });

  it("refuses an extra column with invalid_field, naming it", () => {
    const e = errorOf(csv(`${HEADER},first_name\na@x.io,subscribed,double,sendy,Ada\n`));
    expect(e).toMatchObject({ code: "invalid_field", column: "first_name", row: 0 });
  });

  it("refuses a column name that isn't written in lowercase, and says so", () => {
    const e = errorOf(csv("email,Status,opt_in,origin\na@x.io,subscribed,double,sendy\n"));
    expect(e.column).toBe("Status");
    expect(e.message).toContain('"status"');
  });

  it("refuses a missing required column", () => {
    const e = errorOf(csv("email,status,origin\na@x.io,subscribed,sendy\n"));
    expect(e).toMatchObject({ code: "invalid_field", column: "opt_in" });
  });

  it("refuses a file that isn't this format at all, such as another service's export", () => {
    const e = errorOf(csv("Email Address,First Name,MEMBER_RATING\na@x.io,Ada,2\n"));
    expect(e.code).toBe("unrecognized_format");
  });

  it("refuses a value outside its column's set, naming the row, the column, and the values", () => {
    const e = errorOf(
      csv(`${HEADER}\na@x.io,subscribed,double,sendy\nb@x.io,active,double,sendy\n`),
    );
    expect(e).toMatchObject({
      code: "invalid_field",
      row: 2,
      column: "status",
      allowed: ["subscribed", "pending", "unsubscribed", "none"],
    });
  });

  it("refuses a time without a zone rather than interpreting it", () => {
    const e = errorOf(
      csv(`${HEADER},subscribed_at\na@x.io,subscribed,double,sendy,2024-03-01 09:30\n`),
    );
    expect(e).toMatchObject({ code: "invalid_field", row: 1, column: "subscribed_at" });
    expect(
      errorOf(csv(`${HEADER},confirmed_at\na@x.io,subscribed,double,sendy,2024-03-01\n`)).code,
    ).toBe("invalid_field");
  });

  it("reads a time with its zone as the instant it names", () => {
    const [row] = rowsOf(
      csv(`${HEADER},subscribed_at\na@x.io,subscribed,double,sendy,2024-03-01T10:30:00+01:00\n`),
    );
    expect(row?.subscribed_at).toBe(Date.parse("2024-03-01T09:30:00Z"));
  });

  it("takes evidence only as a JSON object of at most 500 bytes", () => {
    const ok = rowsOf(
      csv(`${HEADER},evidence\na@x.io,subscribed,double,sendy,"{ ""ip"": ""1.2.3.4"" }"\n`),
    );
    expect(ok[0]?.evidence).toBe('{"ip":"1.2.3.4"}');
    expect(errorOf(csv(`${HEADER},evidence\na@x.io,subscribed,double,sendy,"[1]"\n`)).column).toBe(
      "evidence",
    );
    const big = JSON.stringify({ note: "x".repeat(600) }).replace(/"/g, '""');
    expect(
      errorOf(csv(`${HEADER},evidence\na@x.io,subscribed,double,sendy,"${big}"\n`)).column,
    ).toBe("evidence");
  });

  it("refuses an origin that isn't a short lowercase name", () => {
    expect(errorOf(csv(`${HEADER}\na@x.io,subscribed,double,Sendy\n`)).column).toBe("origin");
  });

  it("counts an invalid address as an invalid row, never dropping it", () => {
    const rows = rowsOf(csv(`${HEADER}\nnot-an-address,subscribed,double,sendy\n`));
    expect(rows.map((r) => [r.row, r.email, r.valid])).toEqual([[1, "not-an-address", false]]);
  });

  it("refuses a row with the wrong number of values", () => {
    expect(errorOf(csv(`${HEADER}\na@x.io,subscribed,double\n`))).toMatchObject({
      code: "invalid_field",
      row: 1,
    });
  });

  it("refuses text that isn't UTF-8 and a file that is neither .csv nor .txt", () => {
    expect(errorOf(csv(`${HEADER}\na�@x.io,subscribed,double,sendy\n`)).code).toBe(
      "unrecognized_format",
    );
    expect(errorOf(parseImportFile({ name: "list.xlsx", text: HEADER })).code).toBe(
      "unrecognized_format",
    );
  });

  it("refuses an unclosed quote as not valid CSV", () => {
    expect(errorOf(csv(`${HEADER}\n"a@x.io,subscribed,double,sendy\n`)).code).toBe(
      "unrecognized_format",
    );
  });

  it("accepts a byte-order mark and skips blank lines", () => {
    const rows = rowsOf(csv(`﻿${HEADER}\r\n\r\na@x.io,subscribed,double,sendy\r\n\r\n`));
    expect(rows.map((r) => r.email)).toEqual(["a@x.io"]);
  });
});

describe("splitCsv (RFC 4180)", () => {
  it("keeps commas, doubled quotes, and line breaks inside a quoted field", () => {
    expect(splitCsv('a,"b,c","say ""hi""","two\r\nlines"\r\nd,,\n')).toEqual({
      records: [
        ["a", "b,c", 'say "hi"', "two\r\nlines"],
        ["d", "", ""],
      ],
    });
  });

  it("reads a last record with no line break after it", () => {
    expect(splitCsv("a,b\nc,d")).toEqual({
      records: [
        ["a", "b"],
        ["c", "d"],
      ],
    });
  });
});

describe("the plain list (SPEC §7)", () => {
  it("trims lines, skips blank ones, and accepts CRLF and a byte-order mark", () => {
    const rows = rowsOf(txt("﻿ Ada@Example.com \r\n\r\ngrace@example.com\r\n"));
    expect(rows.map((r) => [r.row, r.email, r.status, r.opt_in, r.origin])).toEqual([
      [1, "ada@example.com", "subscribed", "unknown", "unknown"],
      [3, "grace@example.com", "subscribed", "unknown", "unknown"],
    ]);
  });

  it("counts a line that isn't a single address as invalid, without refusing the file", () => {
    const rows = rowsOf(txt("ada@example.com\nAda <ada@example.com>\ngrace@exmaple\n"));
    expect(rows.map((r) => [r.email, r.valid])).toEqual([
      ["ada@example.com", true],
      ["Ada <ada@example.com>", false],
      ["grace@exmaple", false],
    ]);
  });

  it("refuses the whole file when a line has a comma, tab, or semicolon", () => {
    for (const sep of [",", "\t", ";"]) {
      const e = errorOf(txt(`ada@example.com\nb@example.com${sep}subscribed\n`));
      expect(e).toMatchObject({ code: "unrecognized_format", row: 2 });
    }
  });

  it("refuses a file without one valid address", () => {
    expect(errorOf(txt("hello\nworld\n")).code).toBe("unrecognized_format");
    expect(errorOf(txt("\n\n")).code).toBe("unrecognized_format");
  });

  it("carries the declared meaning: unsubscribed, or bounced as a suppression with no claim", () => {
    expect(rowsOf(txt("a@x.io\n", "unsubscribed"))[0]).toMatchObject({
      status: "unsubscribed",
      suppression: null,
    });
    expect(rowsOf(txt("a@x.io\n", "bounced"))[0]).toMatchObject({
      status: "none",
      suppression: "bounce",
    });
  });
});

describe("merging an address's repeats (SPEC §7)", () => {
  const row = (over: Partial<ImportRow>): ImportRow => ({
    row: 1,
    email: "a@x.io",
    valid: true,
    status: "subscribed",
    opt_in: "double",
    origin: "sendy",
    suppression: null,
    subscribed_at: null,
    confirmed_at: null,
    unsubscribed_at: null,
    suppressed_at: null,
    evidence: null,
    ...over,
  });

  it("favors leaving, the strongest suppression, the weakest opt-in, and the outer times", () => {
    const merged = mergeRows([
      row({
        row: 1,
        status: "subscribed",
        opt_in: "double",
        origin: "sendy",
        subscribed_at: 300,
        unsubscribed_at: 10,
        suppression: "manual",
        suppressed_at: 5,
        evidence: '{"a":1}',
      }),
      row({
        row: 2,
        status: "unsubscribed",
        opt_in: "single",
        origin: "mailchimp",
        subscribed_at: 100,
        unsubscribed_at: 50,
        suppression: "complaint",
        suppressed_at: 9,
        evidence: '{"b":2}',
      }),
      row({
        row: 3,
        status: "pending",
        opt_in: "double",
        origin: "other",
        subscribed_at: 200,
        confirmed_at: 7,
        suppression: "bounce",
        evidence: '{"c":3}',
      }),
    ]);
    expect(merged.rows).toEqual([
      row({
        row: 1,
        status: "unsubscribed",
        opt_in: "single",
        origin: "mailchimp",
        suppression: "complaint",
        subscribed_at: 100,
        confirmed_at: 7,
        unsubscribed_at: 50,
        suppressed_at: 9,
        evidence: '{"b":2}',
      }),
    ]);
    expect(merged.repeats.map((r) => r.row)).toEqual([2, 3]);
  });

  it("ranks erased over every other suppression, and unknown as the weakest opt-in", () => {
    const merged = mergeRows([
      row({ row: 1, suppression: "erased", opt_in: "single" }),
      row({ row: 2, suppression: "complaint", opt_in: "unknown" }),
    ]);
    expect(merged.rows[0]).toMatchObject({ suppression: "erased", opt_in: "unknown" });
  });

  it("keeps the first row's origin and evidence when the status ties", () => {
    const merged = mergeRows([
      row({ row: 1, origin: "sendy", evidence: '{"a":1}' }),
      row({ row: 2, origin: "mailchimp", evidence: '{"b":2}' }),
    ]);
    expect(merged.rows[0]).toMatchObject({ origin: "sendy", evidence: '{"a":1}' });
  });

  it("leaves invalid rows out of the merge, each counted on its own", () => {
    const merged = mergeRows([
      row({ row: 1, email: "bad", valid: false }),
      row({ row: 2, email: "bad", valid: false }),
    ]);
    expect(merged.invalid.map((r) => r.row)).toEqual([1, 2]);
    expect(merged.rows).toEqual([]);
  });
});

describe("the templates and the writer", () => {
  it("write every column of the format, in order", () => {
    expect(TEMPLATE_CSV.split("\r\n")[0]).toBe(IMPORT_COLUMNS.map((c) => c.name).join(","));
  });

  it("read back as the rows they were written from", () => {
    const rows = rowsOf(parseImportFile({ name: "template.csv", text: TEMPLATE_CSV }));
    expect(
      rows.map((r) => [r.email, r.status, r.opt_in, r.origin, r.suppression, r.evidence]),
    ).toEqual(
      TEMPLATE_ROWS.map((r) => [r.email, r.status, r.opt_in, r.origin, r.suppression, r.evidence]),
    );
    expect(rowsOf(parseImportFile({ name: "template.txt", text: TEMPLATE_TXT }))).toHaveLength(3);
  });

  it("write a value a spreadsheet would run as a formula as text, and read it back as it was", () => {
    const row: ExportRow = { ...(TEMPLATE_ROWS[0] as ExportRow), email: "=cmd@x.io", origin: "-x" };
    const text = toImportCsv([row]);
    expect(text).toContain("'=cmd@x.io,");
    expect(text).toContain(",'-x,");
    // The reader takes the apostrophe off again.
    expect(rowsOf(csv(text.replace(",'-x,", ",x,")))[0]?.email).toBe("=cmd@x.io");
  });

  it("quote a value that holds a comma, a quote, a line break, or outer spaces", () => {
    const row: ExportRow = {
      ...(TEMPLATE_ROWS[0] as ExportRow),
      evidence: '{"note":"a, \\"b\\""}',
    };
    const text = toImportCsv([row]);
    expect(rowsOf(csv(text))[0]?.evidence).toBe('{"note":"a, \\"b\\""}');
  });
});

describe("a page of the export on Workers Free (SPEC §8)", () => {
  // Free allows 10 ms of CPU a request. workerd's clock stands still during compute, so the
  // page's pure work is timed here, in Node: its JSON, as the Worker answers it, and its CSV,
  // the costlier of the two, as a client writes it. The median of several runs keeps one slow
  // run on a busy machine from failing the check.
  const FREE_CPU_MS = 10;

  function page(): ExportRow[] {
    return Array.from({ length: EXPORT_PAGE_ROWS.free }, (_, i) => ({
      email: `reader.${String(i).padStart(5, "0")}@example.com`,
      status: i % 10 === 0 ? "unsubscribed" : "subscribed",
      opt_in: "double",
      origin: "kestrel",
      suppression: i % 50 === 0 ? "bounce" : null,
      subscribed_at: "2025-06-01T10:00:00.000Z",
      confirmed_at: "2025-06-01T10:12:00.000Z",
      unsubscribed_at: i % 10 === 0 ? "2025-09-01T10:00:00.000Z" : null,
      suppressed_at: i % 50 === 0 ? "2025-08-01T10:00:00.000Z" : null,
      evidence: JSON.stringify({ confirmed_ip: "203.0.113.7", form: "x".repeat(150) }),
      format: IMPORT_FORMAT,
    }));
  }

  function medianMs(work: () => void): number {
    work();
    const runs = Array.from({ length: 7 }, () => {
      const start = performance.now();
      work();
      return performance.now() - start;
    }).sort((a, b) => a - b);
    return runs[3] ?? Number.POSITIVE_INFINITY;
  }

  it("is written within Free's CPU a request, as JSON and as CSV", () => {
    const rows = page();
    expect(medianMs(() => JSON.stringify({ subscribers: rows }))).toBeLessThan(FREE_CPU_MS);
    expect(medianMs(() => toImportCsv(rows))).toBeLessThan(FREE_CPU_MS);
  });
});

describe("attestationPublication (SPEC §9)", () => {
  it("names the publication by the name it set", () => {
    expect(attestationPublication("Field Notes", "Birds <a@b.c>")).toBe("Field Notes");
  });

  it("falls back to the sender's display name", () => {
    expect(attestationPublication("", '"Birds Weekly" <a@b.c>')).toBe("Birds Weekly");
  });

  it("calls it this newsletter with neither", () => {
    expect(attestationPublication("", "a@b.c")).toBe("this newsletter");
  });
});
