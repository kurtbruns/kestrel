// Bringing a list in from the dashboard (SPEC §7, DESIGN §3 Import): the shape Kestrel
// reads before asking for a file, then the server's plan of the chosen file with what the
// commit needs from the publisher, then the import's result. Planning writes nothing, so it
// runs as soon as a file is chosen; the commit sends the plan's hash, so it applies the plan
// on screen or is refused. Every outcome, count, attestation, and warning is the server's.

import {
  type ImportCommitResponse,
  type ImportFormatResponse,
  type ImportPlanResponse,
  type ImportRowResult,
  PLAIN_LIST_STATUSES,
  type PlainListStatus,
  TEMPLATE_ROWS,
  TEMPLATE_TXT,
} from "../../shared/imports";
import { ApiError, api, apiFile, describeError } from "../api";
import { mount } from "../lifecycle";
import { appState } from "../state";
import { codeBlock, wireCopy } from "../ui/copy";
import { $, $$ } from "../ui/dom";
import { saveFile } from "../ui/download";
import { fmt } from "../ui/format";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { busy, fieldError, renderError, toast } from "../ui/widgets";
import {
  confirmedBreakdown,
  confirmedCount,
  extraSuppressionsLine,
  notImportedCsv,
  type OutcomeLine,
  outcomeLines,
} from "./import_plan";

/** The prompt the "Just ask Claude" card offers to copy. */
export const ASK_CLAUDE_PROMPT =
  "Please import my Sendy subscribers from ~/Downloads/sendy-export.csv into the newsletter.";

// The five columns that decide what happens to a row, shown in the Full list sample.
const SAMPLE_COLUMNS = ["email", "status", "opt_in", "origin", "subscribed_at"] as const;

const PLAIN_LABELS: Record<PlainListStatus, string> = {
  subscribed: "Subscribed",
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
};

interface ChosenFile {
  name: string;
  text: string;
}

/** Text with `code` spans, as the format's own words write them, as markup. */
function withCode(text: string): Html {
  return html`${text.split("`").map((part, i) => (i % 2 === 1 ? html`<code>${part}</code>` : part))}`;
}

export async function renderImport(root: HTMLElement, signal: AbortSignal): Promise<void> {
  setHtml(
    root,
    html`<div class="imp">
      <div class="editor-head"><a href="#/subscribers" class="back">← Subscribers</a></div>
      <div class="page-head"><h1>Import subscribers</h1><p class="set-lede" id="impLede">Nothing changes until you review what will happen and confirm.</p></div>
      <div id="impBody" class="muted">Loading…</div>
      <input type="file" id="impInput" accept=".csv,.txt,text/csv,text/plain" hidden>
    </div>`,
  );
  const body = $("#impBody", root);
  const input = $<HTMLInputElement>("#impInput", root);
  wireCopy(body);

  let format: ImportFormatResponse;
  try {
    format = await api<ImportFormatResponse>("/api/imports/format", { signal });
  } catch (e) {
    if (!signal.aborted) {
      renderError(body, describeError(e), () => {
        void mount(renderImport);
      });
    }
    return;
  }
  if (signal.aborted) {
    return;
  }

  // Named as the attestation names it: the publication's own name, or none.
  const publication = appState.appConfig?.settings.publication.name || "this newsletter";
  // The file in hand and what the publisher said its addresses are. Kept only for this
  // page: nothing is stored between the plan and the commit.
  let chosen: ChosenFile | null = null;
  let plainStatus: PlainListStatus = format.plain_list.default;
  let sample: "full" | "plain" = "full";

  // --- 1. The shape Kestrel reads, then the chooser ---------------------------------------
  function paintChooser(error?: string): void {
    $("#impLede", root).hidden = false;
    const limit = format.limits.max_rows.toLocaleString("en-US");
    setHtml(
      body,
      html`<section class="card imp-card">
        <div class="imp-card-head"><h2>The file Kestrel reads</h2>
          <span class="set-wtog" role="group" aria-label="Which file">
            <button type="button" class="wtog-btn" data-sample="full" aria-pressed="${String(sample === "full")}">Full list</button>
            <button type="button" class="wtog-btn" data-sample="plain" aria-pressed="${String(sample === "plain")}">Plain list</button>
          </span>
        </div>
        <div id="impSample">${sample === "full" ? fullSample() : plainSample()}</div>
      </section>
      <section class="card imp-card imp-claude">
        <h2>Just ask Claude</h2>
        <p class="imp-text">Coming from Sendy, Mailchimp, or another service? Claude converts your export and checks it with you before importing.</p>
        ${askClaude()}
      </section>
      <div class="imp-drop" id="impDrop">
        ${icon("upload")}
        <p class="imp-drop-line">Drop your file here, or</p>
        <button type="button" class="primary" id="impChoose" aria-describedby="impLimit${error ? " impFileError" : ""}">Choose file</button>
        <p class="field-hint" id="impLimit">CSV or .txt, up to ${limit} rows.${format.limits.max_rows_reason ? html` ${format.limits.max_rows_reason}` : null}</p>
      </div>
      ${
        error
          ? html`<div class="imp-file-error"><div class="field-error" id="impFileError" role="alert"><span class="field-error-ico" aria-hidden="true">!</span><span>${error}</span></div>
            <p class="imp-text">Exported from another service? Claude can convert it for you. Ask Claude Code:</p>${askClaude()}</div>`
          : null
      }`,
    );
    for (const b of $$<HTMLButtonElement>("[data-sample]", body)) {
      b.onclick = () => {
        sample = b.dataset.sample === "plain" ? "plain" : "full";
        for (const o of $$("[data-sample]", body)) {
          o.setAttribute("aria-pressed", String(o.dataset.sample === sample));
        }
        setHtml($("#impSample", body), sample === "full" ? fullSample() : plainSample());
        wireTemplates();
      };
    }
    wireTemplates();
    $("#impChoose", body).onclick = () => input.click();
    const drop = $("#impDrop", body);
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const file = e.dataTransfer?.files[0];
      if (file) {
        void choose(file);
      }
    });
  }

  function fullSample(): Html {
    const rows = TEMPLATE_ROWS.slice(0, 3);
    const optional = format.columns
      .filter((c) => !c.required && !(SAMPLE_COLUMNS as readonly string[]).includes(c.name))
      .map((c) => c.name);
    return html`<p class="imp-text">A CSV with a header row, one row per address. A row says what your old service recorded about each person; Kestrel decides what that means here.</p>
      <div class="table-wrap"><table class="imp-sample"><thead><tr>${SAMPLE_COLUMNS.map((c) => html`<th><code>${c}</code></th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${SAMPLE_COLUMNS.map((c) => html`<td>${r[c] ?? ""}</td>`)}</tr>`)}</tbody></table></div>
      <p class="field-hint">Optional columns: ${optional.map((n, i) => html`${i ? ", " : ""}<code>${n}</code>`)}.</p>
      <div class="row imp-links"><button type="button" class="ghost" data-template="csv">Download template (CSV)</button><a class="ghost-link" href="#/docs/import-format">Import format reference →</a></div>
      <details class="imp-columns"><summary>Every column</summary>
        <div class="table-wrap"><table class="imp-ref"><thead><tr><th>Column</th><th>Takes</th><th>Meaning</th></tr></thead><tbody>${format.columns.map(
          (c) =>
            html`<tr><td><code>${c.name}</code>${c.required ? html` <span class="muted">required</span>` : null}</td><td>${
              c.values
                ? c.values.map((v, i) => html`${i ? ", " : ""}<code>${v}</code>`)
                : withCode(c.takes)
            }</td><td>${withCode(c.meaning)}</td></tr>`,
        )}</tbody></table></div>
      </details>`;
  }

  function plainSample(): Html {
    return html`<p class="imp-text">A <code>.txt</code> file with one address per line.</p>
      ${codeBlock("email-list.txt", html`${TEMPLATE_TXT.replace(/\r\n/g, "\n").trim()}`, TEMPLATE_TXT)}
      <p class="imp-text">Next you’ll say what they are: subscribed (the default), unsubscribed, or bounced.</p>
      <div class="row imp-links"><button type="button" class="ghost" data-template="txt">Download template (email-list.txt)</button></div>`;
  }

  function askClaude(): Html {
    return codeBlock("Prompt for Claude Code", html`${ASK_CLAUDE_PROMPT}`, ASK_CLAUDE_PROMPT);
  }

  function wireTemplates(): void {
    for (const b of $$<HTMLButtonElement>("[data-template]", body)) {
      b.onclick = () =>
        busy(b, null, async () => {
          const kind = b.dataset.template === "txt" ? "txt" : "csv";
          try {
            const file = await apiFile(`/api/imports/template.${kind}`);
            saveFile(
              file.text,
              file.filename ?? (kind === "txt" ? "email-list.txt" : "kestrel-subscribers.csv"),
              kind === "txt" ? "text/plain" : "text/csv",
            );
          } catch (e) {
            toast(describeError(e));
          }
        });
    }
  }

  // --- 2. A file chosen: planned at once, then confirmed ----------------------------------
  input.onchange = () => {
    const file = input.files?.[0];
    input.value = ""; // so choosing the same file again still plans it
    if (file) {
      void choose(file);
    }
  };

  async function choose(file: File): Promise<void> {
    const text = await file.text();
    if (signal.aborted) {
      return;
    }
    const next = { name: file.name, text };
    // A plain list's addresses start as the default each time a new file is chosen.
    plainStatus = format.plain_list.default;
    const fileButton = body.querySelector<HTMLButtonElement>("#impChoose, #impReplace");
    const planned = await (fileButton
      ? busy(fileButton, "Reading…", () => plan(next))
      : plan(next));
    if (planned === null) {
      return;
    }
    chosen = next;
    paintPlan(planned);
  }

  /** Plan a file. A refusal of the file is said under the chooser, and answers null. */
  async function plan(file: ChosenFile): Promise<ImportPlanResponse | null> {
    try {
      return await api<ImportPlanResponse>("/api/imports/plan", {
        method: "POST",
        json: planBody(file),
      });
    } catch (e) {
      if (!signal.aborted) {
        chosen = null;
        // The server's own words about the file (not in the format, a value it doesn't
        // take, too many rows), or why it couldn't be read at all.
        paintChooser(describeError(e));
        $("#impChoose", body).focus();
      }
      return null;
    }
  }

  function planBody(file: ChosenFile): {
    file: ChosenFile;
    plain_list_status?: PlainListStatus;
  } {
    return isPlain(file) ? { file, plain_list_status: plainStatus } : { file };
  }

  function paintPlan(p: ImportPlanResponse, notice?: string): void {
    const confirming = confirmedCount(p.counts);
    const lines = outcomeLines(p.counts);
    const breakdown = confirmedBreakdown(p.confirmed);
    const extra = extraSuppressionsLine(p.counts, p.suppressions_added);
    const notImported = p.rows.length;
    const kindLabel = p.file.kind === "txt" ? "Plain list (.txt)" : `CSV, ${format.format}`;
    setHtml(
      body,
      html`<section class="card imp-card imp-file">
        <div class="imp-file-row">
          <div><strong class="imp-file-name">${p.file.name}</strong><div class="muted">${kindLabel} · ${rowsText(p.file.rows)} · ${addressesText(p.file.addresses)}</div></div>
          <button type="button" class="ghost" id="impReplace">Replace file</button>
        </div>
        ${p.file.kind === "txt" ? plainStatusControl() : null}
      </section>
      <section class="card imp-card">
        <h2>What will happen</h2>
        ${outcomeList(lines, breakdown, confirming)}
        ${extra ? html`<p class="imp-text">${extra}</p>` : null}
        ${
          notImported > 0
            ? html`<div class="row imp-links"><button type="button" class="ghost" id="impNotImported">Download the ${rowsText(notImported)} not imported as subscribed (CSV)</button></div>`
            : null
        }
        ${p.daily_writes_warning ? html`<p class="hint daily-writes imp-warn" role="status">${p.daily_writes_warning}</p>` : null}
      </section>
      <section class="card imp-card imp-confirm">
        <h2>Confirm</h2>
        ${
          p.sends_growing.length > 0
            ? html`<p class="imp-text">A scheduled post goes to the list as it stands when it sends, so this import adds to its audience. Acknowledge each one.</p>
              ${p.sends_growing.map(
                (s) =>
                  html`<label class="imp-check"><input type="checkbox" data-ack="${s.id}"><span>“${s.subject || "Untitled"}”, sending ${fmt(s.fire_at)}, goes to ${s.gains.toLocaleString("en-US")} more ${s.gains === 1 ? "person" : "people"}.</span></label>`,
              )}`
            : null
        }
        ${
          p.attestation
            ? html`<label class="imp-check"><input type="checkbox" id="impAttest"><span>${p.attestation.text}</span></label>
              <p class="field-hint imp-attest-hint">Only import people who asked to receive ${publication}. If you’re unsure about some, take them out of the file before importing.</p>`
            : null
        }
        ${
          p.attestation === null && p.sends_growing.length === 0
            ? html`<p class="imp-text">Nobody is imported as a subscriber, so there’s nothing to attest.</p>`
            : null
        }
        ${notice ? html`<div class="field-error imp-act-error" role="alert"><span class="field-error-ico" aria-hidden="true">!</span><span>${notice}</span></div>` : null}
        <div class="actions imp-actions"><a class="ghost-link" href="#/subscribers">Cancel</a><button type="button" class="primary" id="impGo">Import</button></div>
      </section>`,
    );
    $("#impReplace", body).onclick = () => input.click();
    if (notImported > 0) {
      $("#impNotImported", body).onclick = () => downloadNotImported(p.file.name, p.rows);
    }
    for (const b of $$<HTMLButtonElement>("[data-plain]", body)) {
      b.onclick = () => {
        const status = b.dataset.plain as PlainListStatus;
        if (status === plainStatus || !chosen) {
          return;
        }
        plainStatus = status;
        const file = chosen;
        void busy(b, null, async () => {
          const next = await plan(file);
          if (next && !signal.aborted) {
            chosen = file;
            paintPlan(next);
            $<HTMLButtonElement>(`[data-plain="${status}"]`, body).focus();
          }
        });
      };
    }
    const go = $<HTMLButtonElement>("#impGo", body);
    go.onclick = () => commit(p, go);
  }

  function plainStatusControl(): Html {
    return html`<div class="imp-plain">
      <span class="imp-plain-label" id="impPlainLabel">These addresses are</span>
      <span class="set-wtog" role="group" aria-labelledby="impPlainLabel">${PLAIN_LIST_STATUSES.map(
        (s) =>
          html`<button type="button" class="wtog-btn" data-plain="${s}" aria-pressed="${String(s === plainStatus)}">${PLAIN_LABELS[s]}</button>`,
      )}</span>
      <p class="field-hint">A plain list doesn’t say how each person joined, so it’s recorded as unknown.</p>
    </div>`;
  }

  function downloadNotImported(fileName: string, rows: ImportRowResult[]): void {
    const base = fileName.replace(/\.(csv|txt)$/i, "");
    saveFile(notImportedCsv(rows), `${base}-not-imported.csv`, "text/csv");
  }

  async function commit(p: ImportPlanResponse, go: HTMLButtonElement): Promise<void> {
    const file = chosen;
    if (!file) {
      return;
    }
    body.querySelector(".imp-act-error")?.remove();
    // Each box the commit needs, unticked, says so where it is, in order down the page.
    const acks = $$<HTMLInputElement>("[data-ack]", body);
    const attest = body.querySelector<HTMLInputElement>("#impAttest");
    for (const box of acks) {
      if (!box.checked) {
        missing(
          box,
          "Tick this to acknowledge that this post will go to the people this import adds.",
        );
        return;
      }
    }
    if (attest && !attest.checked) {
      missing(attest, "Tick this to attest that everyone you’re importing as subscribed opted in.");
      return;
    }
    await busy(go, "Importing…", async () => {
      try {
        const done = await api<ImportCommitResponse>("/api/imports", {
          method: "POST",
          json: {
            ...planBody(file),
            plan_hash: p.plan_hash,
            ...(p.attestation
              ? { attestation: { version: p.attestation.version, accepted: true } }
              : {}),
            acknowledge_sends: p.sends_growing.map((s) => s.id),
          },
        });
        if (!signal.aborted) {
          paintDone(done, p);
        }
      } catch (e) {
        if (signal.aborted) {
          return;
        }
        if (e instanceof ApiError && e.code === "plan_stale") {
          // Another import landed since this plan: plan the same file again and show it, so
          // what the publisher confirms is what the commit would now do.
          const again = await plan(file);
          if (again) {
            chosen = file;
            paintPlan(
              again,
              "Another import was committed after this plan, so here is the plan again as your list stands now. Review it, then import.",
            );
          }
          return;
        }
        paintError(describeError(e));
      }
    });
  }

  function missing(box: HTMLInputElement, message: string): void {
    fieldError(box, message, { after: box.closest("label") ?? box });
    box.focus();
  }

  function paintError(message: string): void {
    body.querySelector(".imp-act-error")?.remove();
    const line = document.createElement("div");
    line.className = "field-error imp-act-error";
    line.setAttribute("role", "alert");
    const ico = document.createElement("span");
    ico.className = "field-error-ico";
    ico.setAttribute("aria-hidden", "true");
    ico.textContent = "!";
    const text = document.createElement("span");
    text.textContent = message;
    line.append(ico, text);
    $(".imp-actions", body).before(line);
  }

  // --- 3. Done ----------------------------------------------------------------------------
  function paintDone(done: ImportCommitResponse, p: ImportPlanResponse): void {
    // The promise that nothing changes yet is kept; what changed is below.
    $("#impLede", root).hidden = true;
    const rec = done.import;
    const who =
      rec.principal.kind === "service"
        ? "Claude, for you"
        : rec.principal.email
          ? rec.principal.email
          : "you";
    const lines = outcomeLines(done.counts);
    const extra = extraSuppressionsLine(done.counts, done.suppressions_added);
    setHtml(
      body,
      html`<section class="card imp-card imp-done">
        <h2 id="impDoneHead" tabindex="-1">${done.replayed ? "This import was already done" : "Import done"}</h2>
        ${
          done.replayed
            ? html`<p class="imp-text">This plan was already imported, so nothing was written again. Here is its record.</p>`
            : null
        }
        ${outcomeList(lines, null, 0)}
        ${extra ? html`<p class="imp-text">${extra}</p>` : null}
        <p class="imp-text imp-nobody">Nobody was emailed. To tell your readers about the move, write a post as usual.</p>
      </section>
      ${
        done.differed.length > 0
          ? html`<section class="card imp-card">
              <h2>Rows that turned out differently</h2>
              <p class="imp-text">Your list changed between the plan and the import, so ${rowsText(done.differed.length)} had a different result. Each was applied to the list as it stood.</p>
              <div class="table-wrap"><table class="imp-ref"><thead><tr><th>Row</th><th>Email</th><th>Planned</th><th>Applied</th></tr></thead><tbody>${done.differed.map(
                (d) =>
                  html`<tr><td>${String(d.row)}</td><td>${d.email}</td><td><code>${d.planned}</code></td><td><code>${d.applied}</code></td></tr>`,
              )}</tbody></table></div>
            </section>`
          : null
      }
      <section class="card imp-card imp-record">
        <h2>The import’s record</h2>
        <dl class="imp-dl">
          <dt>File</dt><dd>${rec.file_name}</dd>
          <dt>Fingerprint</dt><dd><code>${rec.file_sha256.slice(0, 16)}</code></dd>
          <dt>Imported</dt><dd>${fmt(rec.created_at)} by ${who}</dd>
          <dt>Attestation</dt><dd>${
            rec.attestation_version === null
              ? "None needed: nobody was imported as a subscriber."
              : p.attestation
                ? html`“${p.attestation.text}” <span class="muted">(version ${String(rec.attestation_version)})</span>`
                : `Version ${rec.attestation_version}`
          }</dd>
        </dl>
        <div class="actions imp-actions"><button type="button" class="ghost" id="impAnother">Import another file</button><button type="button" class="primary" id="impToList">See your subscribers</button></div>
      </section>`,
    );
    chosen = null;
    $("#impAnother", body).onclick = () => paintChooser();
    $("#impToList", body).onclick = () => {
      location.hash = "#/subscribers";
    };
    $("#impDoneHead", body).focus();
  }

  paintChooser();
}

function isPlain(file: ChosenFile): boolean {
  return file.name.trim().toLowerCase().endsWith(".txt");
}

function rowsText(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;
}

function addressesText(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "address" : "addresses"}`;
}

/** The outcome lines, with the confirmed ones broken down by opt-in and origin, and the lines
 *  this list's own record decided set apart beneath, so nobody reads them as imported. */
function outcomeList(
  lines: OutcomeLine[],
  breakdown: { optIn: string; origin: string } | null,
  confirming: number,
): Html {
  const main = lines.filter((l) => !l.kept);
  const kept = lines.filter((l) => l.kept);
  // The breakdown rides the first line that confirms anyone, and covers every one confirmed.
  const breakdownOn = main.find(
    (l) => l.outcome === "create_confirmed" || l.outcome === "confirm_pending",
  )?.outcome;
  return html`<ul class="imp-outcomes">${main.map(
    (l) =>
      html`<li data-outcome="${l.outcome}"><span>${l.text}</span>${
        l.outcome === breakdownOn && breakdown && confirming > 0
          ? html`<div class="field-hint imp-breakdown">Of the ${confirming.toLocaleString("en-US")} confirmed, by opt-in: ${breakdown.optIn}. From: ${breakdown.origin}.</div>`
          : null
      }</li>`,
  )}</ul>
  ${
    kept.length > 0
      ? html`<p class="imp-kept-head">Kept as they are here</p><ul class="imp-outcomes imp-kept">${kept.map(
          (l) => html`<li data-outcome="${l.outcome}"><span>${l.text}</span></li>`,
        )}</ul>`
      : null
  }`;
}
