import { describe, expect, it } from "vitest";
import { IMPORT_OUTCOMES, type ImportOutcome, type OutcomeCounts } from "../../shared/imports";
import {
  confirmedBreakdown,
  extraSuppressionsLine,
  notImportedCsv,
  outcomeLines,
  rowDifferences,
} from "./import_plan";

const counts = (over: Partial<OutcomeCounts>): OutcomeCounts => ({
  ...(Object.fromEntries(IMPORT_OUTCOMES.map((o) => [o, 0])) as OutcomeCounts),
  ...over,
});

describe("outcomeLines", () => {
  it("words each outcome with a count, in reading order, and sets apart what the list keeps (SPEC §7)", () => {
    const lines = outcomeLines(
      counts({
        kept_confirmed_newer: 1,
        merged: 3,
        create_confirmed: 25,
        blocked_by_suppression: 2,
        create_unsubscribed: 5,
        invalid: 1,
      }),
    );
    expect(lines.map((l) => [l.outcome, l.count, l.kept])).toEqual([
      ["create_confirmed", 25, false],
      ["create_unsubscribed", 5, false],
      ["invalid", 1, false],
      ["merged", 3, false],
      ["blocked_by_suppression", 2, true],
      ["kept_confirmed_newer", 1, true],
    ]);
    expect(lines[0]?.text).toBe("25 addresses added as confirmed subscribers");
    expect(lines[2]?.text).toBe("1 row isn’t a valid address");
    expect(lines[5]?.text).toBe(
      "1 reader confirmed here after the file says they left, and stays confirmed",
    );
  });

  it("gives a line for every outcome the server has", () => {
    const all = counts(Object.fromEntries(IMPORT_OUTCOMES.map((o) => [o, 2])));
    expect(
      outcomeLines(all)
        .map((l) => l.outcome)
        .sort(),
    ).toEqual([...IMPORT_OUTCOMES].sort());
  });
});

describe("extraSuppressionsLine", () => {
  it("says once how many rows of other outcomes also gain a suppression", () => {
    expect(extraSuppressionsLine(counts({ suppression_added: 2 }), 2)).toBeNull();
    expect(extraSuppressionsLine(counts({ suppression_added: 2 }), 3)).toBe(
      "1 of the addresses above also gains a suppression, so it’s never mailed.",
    );
  });
});

describe("confirmedBreakdown", () => {
  it("counts who is confirmed by opt-in and by origin, leaving out the empty ones", () => {
    expect(
      confirmedBreakdown({
        opt_in: { double: 20, single: 0, unknown: 5 },
        origin: { unknown: 5, sendy: 20, mailchimp: 0 },
      }),
    ).toEqual({ optIn: "20 double opt-in, 5 opt-in unknown", origin: "Sendy 20, unknown 5" });
  });
});

describe("notImportedCsv", () => {
  it("lists the rows not imported as subscribed, guarding a cell a spreadsheet would run", () => {
    expect(
      notImportedCsv([
        {
          row: 3,
          email: "left@example.com",
          outcome: "create_unsubscribed",
          suppression_added: false,
        },
        { row: 7, email: "=1+1", outcome: "invalid", suppression_added: false },
        {
          row: 9,
          email: "gone@example.com",
          outcome: "suppression_added",
          suppression_added: true,
        },
      ]),
    ).toBe(
      "row,email,outcome,suppression_added\r\n3,left@example.com,create_unsubscribed,no\r\n7,'=1+1,invalid,no\r\n9,gone@example.com,suppression_added,yes\r\n",
    );
  });
});

describe("rowDifferences", () => {
  const row = (n: number, email: string, outcome: ImportOutcome) => ({
    row: n,
    email,
    outcome,
    suppression_added: false,
  });

  it("finds a row the plan on screen confirmed that was kept back, and the reverse (SPEC §7)", () => {
    const planned = [row(2, "a@x.com", "invalid"), row(5, "b@x.com", "blocked_by_suppression")];
    const applied = [row(2, "a@x.com", "invalid"), row(4, "c@x.com", "kept_unsubscribed")];
    expect(rowDifferences(planned, applied, [])).toEqual([
      { row: 4, email: "c@x.com", planned: "Imported as subscribed", applied: "Kept unsubscribed" },
      {
        row: 5,
        email: "b@x.com",
        planned: "Blocked by a suppression here",
        applied: "Imported as subscribed",
      },
    ]);
  });

  it("adds the server's own differences, once, and drops a change between two confirming outcomes", () => {
    const applied = [row(3, "d@x.com", "unchanged")];
    expect(
      rowDifferences([], applied, [
        { row: 3, email: "d@x.com", planned: "create_confirmed", applied: "unchanged" },
        { row: 6, email: "e@x.com", planned: "create_confirmed", applied: "confirm_pending" },
      ]),
    ).toEqual([
      { row: 3, email: "d@x.com", planned: "Imported as subscribed", applied: "Unchanged" },
    ]);
  });

  it("is empty when the result is the plan", () => {
    const rows = [row(2, "a@x.com", "create_unsubscribed")];
    expect(rowDifferences(rows, rows, [])).toEqual([]);
  });
});
