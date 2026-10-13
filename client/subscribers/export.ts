// Taking the whole list out (SPEC §7): the export read a page at a time to its last page,
// written as one CSV in the import format by the shared writer, so the file is the one the
// server would write.

import { type ExportResponse, type ExportRow, toImportCsv } from "../../shared/imports";
import { api } from "../api";

/** Every page of the export, followed from the first to the one whose `next` is null. */
async function readExport(): Promise<{ rows: ExportRow[]; exportedAt: number }> {
  const rows: ExportRow[] = [];
  let after: string | null = null;
  let exportedAt = Date.now();
  do {
    const query: string = after === null ? "" : `?after=${encodeURIComponent(after)}`;
    const page: ExportResponse = await api<ExportResponse>(`/api/subscribers/export${query}`);
    // A cursor that names the page just read would loop forever; stop and say so.
    if (page.next !== null && page.next === after) {
      throw new Error("The export repeated a page. Try again.");
    }
    rows.push(...page.subscribers);
    exportedAt = page.exported_at;
    after = page.next;
  } while (after !== null);
  return { rows, exportedAt };
}

/** The export's file: its name, dated by when the export began (UTC), and its CSV text. */
export async function exportFile(): Promise<{ name: string; text: string }> {
  const { rows, exportedAt } = await readExport();
  const day = new Date(exportedAt).toISOString().slice(0, 10);
  return { name: `kestrel-subscribers-${day}.csv`, text: toImportCsv(rows) };
}
