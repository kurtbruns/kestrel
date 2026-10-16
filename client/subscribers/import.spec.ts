import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeFormat,
  IMPORT_OUTCOMES,
  type ImportCommitResponse,
  type ImportPlanResponse,
  type OutcomeCounts,
  type PlainListStatus,
  TEMPLATE_CSV,
} from "../../shared/imports";
import { appState } from "../state";
import {
  $,
  $$,
  captureDownloads,
  type FakeApi,
  type FakeRequest,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settingsResponse,
  settle,
} from "../test/support";
import { ASK_CLAUDE_PROMPT, renderImport, STALE_NOTICE } from "./import";

const counts = (over: Partial<OutcomeCounts>): OutcomeCounts => ({
  ...(Object.fromEntries(IMPORT_OUTCOMES.map((o) => [o, 0])) as OutcomeCounts),
  ...over,
});

const ATTEST =
  "Everyone I’m importing as subscribed opted in to receive Birds Weekly. This isn’t a purchased, rented, or scraped list.";

/** A plan the server might answer for `name`: 25 confirmed and 5 left, unless `over` says otherwise. */
function planFor(name: string, over: Partial<ImportPlanResponse> = {}): ImportPlanResponse {
  return {
    file: {
      name,
      kind: name.endsWith(".txt") ? "txt" : "csv",
      rows: 36,
      addresses: 32,
      plain_list_status: name.endsWith(".txt") ? "subscribed" : null,
    },
    counts: counts({
      create_confirmed: 25,
      create_unsubscribed: 5,
      invalid: 1,
      merged: 3,
      suppression_added: 2,
    }),
    suppressions_added: 2,
    confirmed: { opt_in: { double: 0, single: 0, unknown: 25 }, origin: { mailchimp: 25 } },
    rows: [
      {
        row: 30,
        email: "charles@example.com",
        outcome: "create_unsubscribed",
        suppression_added: false,
      },
    ],
    sends_growing: [],
    attestation: { version: 1, text: ATTEST, publication: "Birds Weekly" },
    plan_hash: "hash-1",
    workers_plan_advice: null,
    ...over,
  };
}

/** A plain list's plan, as the server answers for `status`: subscribed confirms and needs
 *  the attestation; anything else only suppresses. */
function plainPlan(name: string, status: PlainListStatus): ImportPlanResponse {
  const subscribing = status === "subscribed";
  return planFor(name, {
    file: { name, kind: "txt", rows: 3, addresses: 3, plain_list_status: status },
    attestation: subscribing ? { version: 1, text: ATTEST, publication: "Birds Weekly" } : null,
    counts: counts(subscribing ? { create_confirmed: 3 } : { suppression_added: 3 }),
    plan_hash: `hash-${status}`,
  });
}

function committed(over: Partial<ImportCommitResponse> = {}): ImportCommitResponse {
  return {
    import: {
      id: "imp1",
      created_at: Date.now(),
      principal: { kind: "human", email: "pub@birds.example" },
      attestation_version: 1,
      file_name: "list.csv",
      file_sha256: "ab".repeat(32),
      plan_hash: "hash-1",
      counts: counts({ create_confirmed: 25 }),
      suppressions_added: 0,
    },
    counts: counts({ create_confirmed: 25 }),
    suppressions_added: 0,
    rows: [],
    differed: [],
    replayed: false,
    ...over,
  };
}

const formatRoute = {
  path: "/api/imports/format",
  reply: () =>
    describeFormat(1000, "On the Workers Free plan’s limits, an import takes 1,000 rows."),
};

/** Choose a file the way the file picker does: the input's files, then its change event. */
async function chooseFile(name: string, text: string): Promise<void> {
  const input = $<HTMLInputElement>("#impInput");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File([text], name, { type: name.endsWith(".txt") ? "text/plain" : "text/csv" })],
  });
  input.dispatchEvent(new Event("change"));
  await settle();
}

const commits = (fake: FakeApi): FakeRequest[] =>
  fake.calls.filter((c) => c.method === "POST" && c.url.pathname === "/api/imports");

describe("import view", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    appState.appConfig = settingsResponse();
    location.hash = "#/subscribers/import";
  });
  afterEach(() => {
    fake?.restore();
    vi.restoreAllMocks();
  });

  it("shows the shape Kestrel reads before asking for a file, with this deployment's row limit", async () => {
    fake = fakeApi([formatRoute]);
    await mount(renderImport);
    await settle();
    expect($(".set-lede").textContent).toBe(
      "Nothing changes until you review what will happen and confirm.",
    );
    // Full list first: the five columns that decide a row, as the template writes them.
    expect($$(".imp-sample th").map((th) => th.textContent)).toEqual([
      "email",
      "status",
      "opt_in",
      "origin",
      "subscribed_at",
    ]);
    expect($$(".imp-sample tbody tr")).toHaveLength(3);
    // Each column is described in one place, the reference page the link opens.
    expect(document.querySelector(".imp-ref")).toBe(null);
    expect($<HTMLAnchorElement>(".imp-links a").getAttribute("href")).toBe(
      "#/docs/your-list/the-file-format",
    );
    expect($("#impLimit").textContent).toBe(
      "CSV or .txt, up to 1,000 rows. On the Workers Free plan’s limits, an import takes 1,000 rows.",
    );
    // The view's one Primary is the chooser.
    expect($$("#app button.primary").map((b) => b.textContent)).toEqual(["Choose file"]);
    expect($(".imp-claude").textContent).toContain(ASK_CLAUDE_PROMPT);
    // Plain list: one address per line, and its own template.
    $("[data-sample='plain']").click();
    expect($("[data-sample='plain']").getAttribute("aria-pressed")).toBe("true");
    expect($("#impSample").textContent).toContain("ada@example.com\ngrace@example.com");
    expect($("[data-template]").textContent).toBe("Download example file (.txt)");
    expect(fake.unhandled).toEqual([]);
  });

  it("downloads the example file the server serves, under the server's name for it", async () => {
    fake = fakeApi([
      formatRoute,
      {
        path: "/api/imports/template.csv",
        reply: () =>
          new Response(TEMPLATE_CSV, {
            headers: { "content-disposition": 'attachment; filename="kestrel-import-example.csv"' },
          }),
      },
    ]);
    const saved = captureDownloads();
    await mount(renderImport);
    await settle();
    $("[data-template='csv']").click();
    await settle();
    expect(saved.map((f) => f.name)).toEqual(["kestrel-import-example.csv"]);
    expect(await saved[0]?.blob.text()).toBe(TEMPLATE_CSV);
  });

  it("refuses a file that isn't in the format under the chooser, in the server's words, and offers Claude", async () => {
    const said = "This isn’t a kestrel-subscribers/1 file: its first row must name the columns.";
    fake = fakeApi([
      formatRoute,
      {
        method: "POST",
        path: "/api/imports/plan",
        reply: () => jsonResponse({ error: "unrecognized_format", message: said, row: 0 }, 400),
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("sendy-export.csv", "Email,Name\nada@example.com,Ada\n");
    const error = $("#impFileError");
    expect(error.textContent).toContain(said);
    expect($("#impChoose").getAttribute("aria-describedby")).toContain("impFileError");
    expect($(".imp-file-error").textContent).toContain(ASK_CLAUDE_PROMPT);
    expect(document.activeElement).toBe($("#impChoose"));
    expect(commits(fake)).toEqual([]);
    expect(fake.unhandled).toEqual([]);
  });

  it("plans a file as soon as it's chosen, and shows what will happen, with what the list keeps apart (SPEC §7)", async () => {
    fake = fakeApi([
      formatRoute,
      {
        method: "POST",
        path: "/api/imports/plan",
        reply: (req) =>
          planFor((req.json() as { file: { name: string } }).file.name, {
            counts: counts({
              create_confirmed: 25,
              kept_unsubscribed: 2,
              blocked_by_suppression: 1,
            }),
            workers_plan_advice:
              "On the Workers Free plan’s limits, this import leaves 3,025 confirmed subscribers.",
          }),
      },
    ]);
    const saved = captureDownloads();
    await mount(renderImport);
    await settle();
    await chooseFile("list.csv", "email,status,opt_in,origin\n");
    const plans = fake.calls.filter((c) => c.url.pathname === "/api/imports/plan");
    expect(plans.map((c) => c.json())).toEqual([
      { file: { name: "list.csv", text: "email,status,opt_in,origin\n" } },
    ]);
    expect($(".imp-file").textContent).toContain("list.csv");
    expect($(".imp-file").textContent).toContain("36 rows · 32 addresses");
    // Focus moves to the plan, where the reading starts.
    expect(document.activeElement).toBe($(".imp-file"));
    expect($$(".imp-outcomes:not(.imp-kept) li").map((li) => li.dataset.outcome)).toEqual([
      "create_confirmed",
    ]);
    expect($(".imp-breakdown").textContent).toBe(
      "Of the 25 confirmed, by opt-in: 25 opt-in unknown. From: Mailchimp 25.",
    );
    expect($$(".imp-kept li").map((li) => li.dataset.outcome)).toEqual([
      "blocked_by_suppression",
      "kept_unsubscribed",
    ]);
    // The plan's warning is shown as the plan returns it.
    expect($(".workers-plan").textContent).toBe(
      "On the Workers Free plan’s limits, this import leaves 3,025 confirmed subscribers.",
    );
    // The attestation the plan returns, unticked, and the publication named under it.
    expect($("label.imp-check").textContent).toBe(ATTEST);
    expect($<HTMLInputElement>("#impAttest").checked).toBe(false);
    expect($(".imp-attest-hint").textContent).toBe(
      "Only import people who asked to receive Birds Weekly. If you’re unsure about some, take them out of the file before importing.",
    );
    $("#impNotImported").click();
    expect(saved.map((f) => f.name)).toEqual(["list-not-imported.csv"]);
    expect(await saved[0]?.blob.text()).toBe(
      "row,email,outcome,suppression_added\r\n30,charles@example.com,create_unsubscribed,no\r\n",
    );
    expect(fake.unhandled).toEqual([]);
  });

  it("names the publication under the attestation as the plan names it, not as the settings it loaded do (SPEC §9)", async () => {
    // Settings changed in another tab since this one loaded them: the plan is the server's word.
    appState.appConfig = settingsResponse({
      settings: { publication: { name: "Old Name", tagline: "", address: "", logoUrl: "" } },
    });
    const text =
      "Everyone I’m importing as subscribed opted in to receive Field Notes. This isn’t a purchased, rented, or scraped list.";
    fake = fakeApi([
      formatRoute,
      {
        method: "POST",
        path: "/api/imports/plan",
        reply: () =>
          planFor("list.csv", { attestation: { version: 1, text, publication: "Field Notes" } }),
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("list.csv", "email,status,opt_in,origin\n");
    expect($("label.imp-check").textContent).toBe(text);
    expect($(".imp-attest-hint").textContent).toBe(
      "Only import people who asked to receive Field Notes. If you’re unsure about some, take them out of the file before importing.",
    );
    expect(fake.unhandled).toEqual([]);
  });

  it("asks what a plain list's addresses are, plans again when the answer changes, and commits the plan's answer", async () => {
    const held: { release?: () => void } = {};
    fake = fakeApi([
      formatRoute,
      {
        method: "POST",
        path: "/api/imports/plan",
        reply: (req) => {
          const body = req.json() as { file: { name: string }; plain_list_status: PlainListStatus };
          const p = plainPlan(body.file.name, body.plain_list_status);
          // The re-plan is held open, to see the page while it's on its way.
          return body.plain_list_status === "bounced"
            ? new Promise((resolve) => {
                held.release = () => resolve(p);
              })
            : p;
        },
      },
      {
        method: "POST",
        path: "/api/imports",
        reply: () => jsonResponse(committed({ counts: counts({ suppression_added: 3 }) }), 201),
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("list.txt", "a@example.com\nb@example.com\nc@example.com\n");
    expect($("[data-plain='subscribed']").getAttribute("aria-pressed")).toBe("true");
    expect($(".imp-plain").textContent).toContain("recorded as unknown");
    $("[data-plain='bounced']").click();
    await settle();
    // While the new answer is planned, the plan on screen can't be committed, and nothing
    // can start another plan that the held one would then paint over.
    expect($<HTMLButtonElement>("#impGo").disabled).toBe(true);
    expect($$<HTMLButtonElement>("[data-plain]").map((t) => t.disabled)).toEqual([
      true,
      true,
      true,
    ]);
    expect($<HTMLButtonElement>("#impReplace").disabled).toBe(true);
    $("#impGo").click();
    held.release?.();
    await settle();
    const plans = fake.calls.filter((c) => c.url.pathname === "/api/imports/plan");
    expect(plans.map((c) => (c.json() as { plain_list_status: string }).plain_list_status)).toEqual(
      ["subscribed", "bounced"],
    );
    expect($("[data-plain='bounced']").getAttribute("aria-pressed")).toBe("true");
    expect($$("#impAttest")).toHaveLength(0);
    expect($(".imp-confirm").textContent).toContain("nothing to attest");
    expect(commits(fake)).toEqual([]);
    $("#impGo").click();
    await settle();
    // The commit carries the answer the plan on screen was made with.
    expect(commits(fake).map((c) => c.json())).toEqual([
      {
        file: { name: "list.txt", text: "a@example.com\nb@example.com\nc@example.com\n" },
        plain_list_status: "bounced",
        plan_hash: "hash-bounced",
        acknowledge_sends: [],
      },
    ]);
    expect(fake.unhandled).toEqual([]);
  });

  it("plans a replacing plain list as subscribed again, whatever the last file was", async () => {
    fake = fakeApi([
      formatRoute,
      {
        method: "POST",
        path: "/api/imports/plan",
        reply: (req) => {
          const body = req.json() as { file: { name: string }; plain_list_status: PlainListStatus };
          return plainPlan(body.file.name, body.plain_list_status);
        },
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("first.txt", "a@example.com\n");
    $("[data-plain='bounced']").click();
    await settle();
    expect($("[data-plain='bounced']").getAttribute("aria-pressed")).toBe("true");
    $("#impReplace").click(); // opens the picker; the choice arrives as a change
    await chooseFile("second.txt", "b@example.com\n");
    expect($(".imp-file-name").textContent).toBe("second.txt");
    expect($("[data-plain='subscribed']").getAttribute("aria-pressed")).toBe("true");
    const last = fake.calls.filter((c) => c.url.pathname === "/api/imports/plan").at(-1);
    expect(last?.json()).toEqual({
      file: { name: "second.txt", text: "b@example.com\n" },
      plain_list_status: "subscribed",
    });
    expect(fake.unhandled).toEqual([]);
  });

  it("starts a replacing file's confirmation over, its boxes unticked", async () => {
    fake = fakeApi([
      formatRoute,
      {
        method: "POST",
        path: "/api/imports/plan",
        reply: (req) => planFor((req.json() as { file: { name: string } }).file.name),
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("first.csv", "x");
    $<HTMLInputElement>("#impAttest").click();
    expect($<HTMLInputElement>("#impAttest").checked).toBe(true);
    $("#impReplace").click();
    await chooseFile("second.csv", "y");
    expect($(".imp-file-name").textContent).toBe("second.csv");
    expect($<HTMLInputElement>("#impAttest").checked).toBe(false);
    expect(fake.unhandled).toEqual([]);
  });

  it("holds Replace file and the plain list's answer while the import is committed", async () => {
    const held: { release?: () => void } = {};
    fake = fakeApi([
      formatRoute,
      {
        method: "POST",
        path: "/api/imports/plan",
        reply: () => plainPlan("list.txt", "unsubscribed"),
      },
      {
        method: "POST",
        path: "/api/imports",
        reply: () =>
          new Promise((resolve) => {
            held.release = () => resolve(jsonResponse(committed(), 201));
          }),
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("list.txt", "a@example.com\n");
    $("#impGo").click();
    await settle();
    expect($("#impGo").textContent).toBe("Importing…");
    expect($<HTMLButtonElement>("#impReplace").disabled).toBe(true);
    expect($$<HTMLButtonElement>("[data-plain]").every((t) => t.disabled)).toBe(true);
    held.release?.();
    await settle();
    expect($("#impDoneHead").textContent).toBe("Import done");
    expect(fake.unhandled).toEqual([]);
  });

  it("says which box is missing when Import is pressed unticked, and commits nothing", async () => {
    fake = fakeApi([
      formatRoute,
      {
        method: "POST",
        path: "/api/imports/plan",
        reply: () =>
          planFor("list.csv", {
            sends_growing: [
              { id: "s1", subject: "Owls", fire_at: Date.now() + 3_600_000, gains: 25 },
            ],
          }),
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("list.csv", "x");
    $("#impGo").click();
    await settle();
    const ack = $<HTMLInputElement>("[data-ack='s1']");
    expect(ack.closest("label")?.nextElementSibling?.textContent).toContain(
      "Tick this to acknowledge that this post will go to the people this import adds.",
    );
    expect(document.activeElement).toBe(ack);
    ack.click();
    $("#impGo").click();
    await settle();
    const attest = $<HTMLInputElement>("#impAttest");
    expect(attest.closest("label")?.nextElementSibling?.textContent).toContain(
      "Tick this to attest that everyone you’re importing as subscribed opted in.",
    );
    expect(commits(fake)).toEqual([]);
    expect(fake.unhandled).toEqual([]);
  });

  it("commits the plan on screen with the attestation and each send acknowledged, then shows the result", async () => {
    fake = fakeApi([
      formatRoute,
      {
        method: "POST",
        path: "/api/imports/plan",
        reply: () =>
          planFor("list.csv", {
            sends_growing: [
              { id: "s1", subject: "Owls", fire_at: Date.now() + 3_600_000, gains: 25 },
            ],
          }),
      },
      {
        method: "POST",
        path: "/api/imports",
        reply: () =>
          jsonResponse(
            committed({
              rows: planFor("list.csv").rows,
              differed: [
                {
                  row: 4,
                  email: "ada@example.com",
                  planned: "create_confirmed",
                  applied: "unchanged",
                },
              ],
            }),
            201,
          ),
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("list.csv", "the file");
    $<HTMLInputElement>("[data-ack='s1']").click();
    $<HTMLInputElement>("#impAttest").click();
    $("#impGo").click();
    await settle();
    expect(commits(fake).map((c) => c.json())).toEqual([
      {
        file: { name: "list.csv", text: "the file" },
        plan_hash: "hash-1",
        attestation: { version: 1, accepted: true },
        acknowledge_sends: ["s1"],
      },
    ]);
    expect($("#impDoneHead").textContent).toBe("Import done");
    expect(document.activeElement).toBe($("#impDoneHead"));
    expect($<HTMLElement>("#impLede").hidden).toBe(true);
    expect($(".imp-done").textContent).toContain("Nobody was emailed.");
    expect($(".imp-record").textContent).toContain("pub@birds.example");
    expect($(".imp-record").textContent).toContain(ATTEST);
    expect($$(".imp-differed tbody tr").map((tr) => tr.textContent)).toEqual([
      "4ada@example.comImported as subscribedUnchanged",
    ]);
    // Another file starts over at the chooser, with focus on it.
    $("#impAnother").click();
    expect(document.activeElement).toBe($("#impChoose"));
    expect(fake.unhandled).toEqual([]);
  });

  it("lists a row that turned out differently from the plan on screen, which the commit's own plan can't see (SPEC §7)", async () => {
    // Planned as confirmed, so absent from the plan's rows; the reader unsubscribed before the
    // commit, whose own plan already kept them, so the server's differed is empty.
    fake = fakeApi([
      formatRoute,
      { method: "POST", path: "/api/imports/plan", reply: () => planFor("list.csv") },
      {
        method: "POST",
        path: "/api/imports",
        reply: () =>
          jsonResponse(
            committed({
              counts: counts({ create_confirmed: 24, kept_unsubscribed: 1 }),
              rows: [
                ...planFor("list.csv").rows,
                {
                  row: 7,
                  email: "rosa@example.com",
                  outcome: "kept_unsubscribed",
                  suppression_added: false,
                },
              ],
            }),
            201,
          ),
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("list.csv", "the file");
    $<HTMLInputElement>("#impAttest").click();
    $("#impGo").click();
    await settle();
    expect($(".imp-differed").textContent).toContain("so 1 row had a different result");
    expect($$(".imp-differed tbody tr").map((tr) => tr.textContent)).toEqual([
      "7rosa@example.comImported as subscribedKept unsubscribed",
    ]);
    expect(fake.unhandled).toEqual([]);
  });

  it("says nothing turned out differently when the result is the plan on screen", async () => {
    fake = fakeApi([
      formatRoute,
      { method: "POST", path: "/api/imports/plan", reply: () => planFor("list.csv") },
      {
        method: "POST",
        path: "/api/imports",
        reply: () => jsonResponse(committed({ rows: planFor("list.csv").rows }), 201),
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("list.csv", "the file");
    $<HTMLInputElement>("#impAttest").click();
    $("#impGo").click();
    await settle();
    expect($("#impDoneHead").textContent).toBe("Import done");
    expect(document.querySelector(".imp-differed")).toBe(null);
    expect(fake.unhandled).toEqual([]);
  });

  it("plans the file again when the plan went stale, says why, and asks again (plan_stale)", async () => {
    let hash = "hash-1";
    fake = fakeApi([
      formatRoute,
      {
        method: "POST",
        path: "/api/imports/plan",
        reply: () => planFor("list.csv", { plan_hash: hash }),
      },
      {
        method: "POST",
        path: "/api/imports",
        reply: () => {
          hash = "hash-2";
          return jsonResponse({ error: "plan_stale", message: "Plan the import again." }, 409);
        },
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("list.csv", "the file");
    $<HTMLInputElement>("#impAttest").click();
    $("#impGo").click();
    await settle();
    expect(fake.calls.filter((c) => c.url.pathname === "/api/imports/plan")).toHaveLength(2);
    expect($(".imp-act-error").textContent).toBe(`!${STALE_NOTICE}`);
    expect(STALE_NOTICE).toBe(
      "Your list or its scheduled posts changed since this plan, so here is the plan again as things stand now. Review it, then import.",
    );
    expect(document.activeElement).toBe($(".imp-act-error"));
    expect($<HTMLInputElement>("#impAttest").checked).toBe(false);
    $<HTMLInputElement>("#impAttest").click();
    $("#impGo").click();
    await settle();
    expect(commits(fake).map((c) => (c.json() as { plan_hash: string }).plan_hash)).toEqual([
      "hash-1",
      "hash-2",
    ]);
  });

  it("commits an import that confirms no one without an attestation", async () => {
    fake = fakeApi([
      formatRoute,
      {
        method: "POST",
        path: "/api/imports/plan",
        reply: () =>
          planFor("left.csv", { attestation: null, counts: counts({ create_unsubscribed: 5 }) }),
      },
      {
        method: "POST",
        path: "/api/imports",
        reply: () =>
          jsonResponse(
            committed({
              import: { ...committed().import, attestation_version: null },
              counts: counts({ create_unsubscribed: 5 }),
            }),
            201,
          ),
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("left.csv", "x");
    $("#impGo").click();
    await settle();
    expect(commits(fake).map((c) => c.json())).toEqual([
      { file: { name: "left.csv", text: "x" }, plan_hash: "hash-1", acknowledge_sends: [] },
    ]);
    expect($(".imp-record").textContent).toContain("None needed");
  });

  it("says a refused commit above the actions, in the server's words", async () => {
    fake = fakeApi([
      formatRoute,
      { method: "POST", path: "/api/imports/plan", reply: () => planFor("list.csv") },
      {
        method: "POST",
        path: "/api/imports",
        reply: () =>
          jsonResponse({ error: "internal_error", message: "database unavailable" }, 500),
      },
    ]);
    await mount(renderImport);
    await settle();
    await chooseFile("list.csv", "x");
    $<HTMLInputElement>("#impAttest").click();
    $("#impGo").click();
    await settle();
    expect($(".imp-act-error").textContent).toContain("database unavailable");
    expect($(".imp-act-error").nextElementSibling?.classList.contains("imp-actions")).toBe(true);
  });
});
