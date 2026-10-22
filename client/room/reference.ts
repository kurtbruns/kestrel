// The API reference room, rendered from /api/reference.

import type {
  BodyField,
  QueryParam,
  ReferenceConcept,
  ReferenceEntry,
  ReferenceField,
  ReferenceGroup,
  ReferenceObject,
  ReferenceResource,
  ReferenceResponse,
  ReferenceStatus,
  ReferenceTable,
  RouteError,
  RouteReturns,
} from "../../shared/reference";
import { concretePath, routeAnchor, sharedRefusals } from "../../shared/reference";
import { api, describeError } from "../api";
import { mount, setTitle } from "../lifecycle";
import { appState } from "../state";
import { codeBlock, copyFace, wireCopy } from "../ui/copy";
import { $, $$ } from "../ui/dom";
import { highlightJson, highlightShell } from "../ui/highlight";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { inline, prose } from "../ui/prose";
import { renderError } from "../ui/widgets";
import { curlCommand } from "./curl";
import { roomShell } from "./shell";

// Every route the app and Claude can call, generated from the route manifest
// (src/app.ts) and served as JSON by the authed /api/reference route. The SPA renders it
// natively as one document, as Stripe's and Mux's references are: the Introduction and the
// topics every route shares, then each tier's resources, each opening with the objects its
// routes return and then every route laid out in full, its examples beside its prose. The
// rail lists the resource the reader is in, and the address follows the reading position.

/** What a refusal code means, from the refusal registry, for a route line that adds nothing. */
type Meanings = ReadonlyMap<string, string>;
function apiExample(label: string, value: unknown): Html | null {
  return value === undefined
    ? null
    : codeBlock(label, highlightJson(value), JSON.stringify(value, null, 2));
}
/** The route as a curl command on this instance, with the credential its tier needs. */
function apiCurl(r: ReferenceEntry): Html | null {
  const cmd = curlCommand(r, location.origin, appState.session?.auth.mode ?? "dev");
  return cmd === null ? null : codeBlock("curl", highlightShell(cmd), cmd);
}
/** A name or code that may break only where its words join, after each `_`, `.`, or `/`. */
function breakable(name: string): Html {
  return html`${name.split(/(?<=[_./])/).map((part, i) => html`${i ? html`<wbr>` : null}${part}`)}`;
}
/**
 * One section of a route or an object (its query, body, returns, refusals, fields): a heading
 * over a rule, then its rows unboxed, as Stripe's and Mux's references set theirs. `meta` sits
 * beside the heading, quieter (a body's media types).
 */
function section(label: string, rows: Html | null, meta?: Html | null, lead?: Html | null): Html {
  return html`<div class="block api-sec"><div class="block-head"><span class="block-label">${label}${meta ? html`<span class="api-sec-meta">${meta}</span>` : null}</span></div>${lead ?? null}${rows}</div>`;
}
/** A field's row: its name, type, and whether the request needs it on one line, then what it means. */
function fieldRow(
  name: string,
  type: Html | string | null | undefined,
  required: boolean | undefined,
  desc: Html,
): Html {
  return html`<div class="api-row"><div class="api-row-head"><code class="api-row-name">${breakable(name)}</code>${type ? html`<span class="api-row-type">${type}</span>` : null}${required ? html`<span class="api-req">Required</span>` : null}</div><div class="api-row-desc">${desc}</div></div>`;
}
/**
 * A refusal's or a status's row in a ledger: the status in a column of its own, tinted by its
 * class, so a reader scans by status, then the code, the fields it carries, and what it means.
 */
function ledgerRow(status: number, name: Html, carries: Html | null, desc: Html): Html {
  return html`<div class="api-lrow"><span class="api-st api-st-${String(status)[0]}xx">${status}</span><div><div class="api-row-head"><code class="api-row-name">${name}</code></div>${carries ? html`<div class="api-with">${carries}</div>` : null}<div class="api-row-desc">${desc}</div></div></div>`;
}
// Query params for a list route, so the generated reference documents filter, sort, and
// paging from the registration.
function apiQueryHtml(query: QueryParam[] | undefined): Html | null {
  if (!query?.length) {
    return null;
  }
  const rows = query.map((q) => fieldRow(q.name, null, q.required, inline(q.description)));
  return section("Query", html`<div class="api-list api-query">${rows}</div>`);
}
// A route's body: the media types it takes, from the registration the router enforces them
// by, beside the heading, then its fields, each with its type and whether the request needs it.
function apiBodyHtml(
  body: BodyField[] | undefined,
  accepts: readonly string[] | undefined,
): Html | null {
  if (!body?.length) {
    return null;
  }
  const rows = body.map((f) => fieldRow(f.name, f.type, f.required, inline(f.description)));
  const types = accepts?.length
    ? html` · ${accepts.map((t, i) => html`${i ? ", " : ""}<code>${t}</code>`)}`
    : null;
  return section("Body", html`<div class="api-list api-body">${rows}</div>`, types);
}
// The refusals the route gives of its own, each with its status and the fields it carries,
// and when: the route's own words, or the code's meaning from the refusal registry, then the
// client's next move.
function apiErrorsHtml(errors: RouteError[] | undefined, meanings: Meanings): Html | null {
  if (!errors?.length) {
    return null;
  }
  const rows = errors.map((e) =>
    ledgerRow(
      e.status,
      breakable(e.code),
      e.details?.length
        ? html`with ${e.details.map((d, i) => html`${i ? ", " : ""}<code>${d}</code>`)}`
        : null,
      html`${inline(e.when ?? meanings.get(e.code) ?? "")}<span class="api-move-next">${e.move}</span>`,
    ),
  );
  return section("Refusals", html`<div class="api-ledger api-errors">${rows}</div>`);
}
// An enum's values as bullets under its field's line; values that fall into groups (a halt
// cause's halt) are listed under each group's name, so no line repeats it.
function valuesHtml(values: NonNullable<ReferenceField["values"]>): Html {
  const list = (vs: typeof values) =>
    html`<ul class="api-values">${vs.map((v) => html`<li><code>${v.value}</code> ${inline(v.description)}</li>`)}</ul>`;
  const groups = [...new Set(values.map((v) => v.group).filter((g) => g !== undefined))];
  if (!groups.length) {
    return list(values);
  }
  return html`${groups.map(
    (g) =>
      html`<div class="api-values-group">${inline(g)}</div>${list(values.filter((v) => v.group === g))}`,
  )}`;
}
// Fields with their types and one line each, an enum's values listed under its line, and a field
// that holds an object linked to that object's section by its type.
function apiFieldsTable(fields: readonly ReferenceField[]): Html {
  const rows = fields.map((f) =>
    fieldRow(
      f.name,
      f.object
        ? html`<a href="#/api-reference/objects-${f.object}" class="api-obj-link" data-sec="objects-${f.object}">${f.type}</a>`
        : f.type,
      false,
      html`${inline(f.description)}${f.values?.length ? valuesHtml(f.values) : null}`,
    ),
  );
  return html`<div class="api-list api-fields">${rows}</div>`;
}
// What a route answers: the object it returns, linked to its section, and its own fields.
function apiReturnsHtml(
  r: RouteReturns | undefined,
  objects: ReadonlyMap<string, string>,
): Html | null {
  if (!r) {
    return null;
  }
  const link = r.object
    ? html`<a href="#/api-reference/objects-${r.object}" class="api-obj-link" data-sec="objects-${r.object}">${objects.get(r.object) ?? r.object}</a>`
    : null;
  const what = link
    ? r.as
      ? html`<p class="api-returns"><code>${r.as}</code>: ${r.list ? html`a list of ${link}` : link}${r.fields?.length ? ", and:" : null}</p>`
      : html`<p class="api-returns">${link}${r.fields?.length ? ", and:" : null}</p>`
    : null;
  return section("Returns", r.fields?.length ? apiFieldsTable(r.fields) : null, null, what);
}
/**
 * The path as a URL path to type (the curl command's own, without the router's pattern
 * syntax), with its parameters marked so the variable parts read at a glance.
 */
function apiPathHtml(path: string): Html {
  return html`${concretePath(path)
    .split(/(:[A-Za-z_]+)/)
    .map((part, i) => (i % 2 ? html`<span class="api-param">${part}</span>` : part))}`;
}
/**
 * A heading's text as a link to its own address, as GitHub's and Stripe's headings are: a click
 * jumps there in place and puts the address in the bar to copy or share, and a link icon shows
 * beside it on hover. `to` is a route's anchor (`route`) or a part of the page's (`sec`).
 */
function selfLink(text: string, to: { route: string } | { sec: string }): Html {
  return "route" in to
    ? html`<a class="api-self" href="#/api-reference/${to.route}" data-route="${to.route}">${icon("link")}${text}</a>`
    : html`<a class="api-self" href="#/api-reference/${to.sec}" data-sec="${to.sec}">${icon("link")}${text}</a>`;
}
/** What a route's detail looks up in the rest of the reference. */
interface Lookups {
  meanings: Meanings;
  objects: ReadonlyMap<string, string>;
  /** The objects each resource section opens with, by its `<tier>-<resource>` key. */
  heads: ReadonlyMap<string, ReferenceObject[]>;
}

/** Each object under the first tier that lists its resource, keyed as that resource's section. */
function objectHeads(ref: ReferenceResponse): Map<string, ReferenceObject[]> {
  const heads = new Map<string, ReferenceObject[]>();
  for (const o of ref.objects) {
    const g = ref.groups.find((t) => t.resources.some((res) => res.key === o.resource));
    if (g) {
      const sec = `${g.access}-${o.resource}`;
      heads.set(sec, [...(heads.get(sec) ?? []), o]);
    }
  }
  return heads;
}
/**
 * What the filter finds a route by: its name, method, path, and summary, the refusal codes it
 * gives of its own (a code pasted from a response), and the object it returns, by key and title.
 */
function routeHay(r: ReferenceEntry, look: Lookups): string {
  const obj = r.returns?.object;
  return [
    r.title,
    r.method,
    concretePath(r.path),
    r.summary,
    ...(r.errors ?? []).map((e) => e.code),
    ...(obj ? [obj, look.objects.get(obj) ?? "", r.returns?.as ?? ""] : []),
  ]
    .join(" ")
    .toLowerCase();
}
// A route, laid out in full as Stripe and Mux lay theirs: its name, method, and path over
// what it does on the left, and its examples and curl command beside them on a wide screen
// (under them on a narrow one).
function apiRouteHtml(r: ReferenceEntry, look: Lookups): Html {
  return html`<li data-hay="${routeHay(r, look)}" data-path="${concretePath(r.path).toLowerCase()}" id="route-${routeAnchor(r)}" data-route="${routeAnchor(r)}"><article class="api-op">
      <div class="api-op-head">
        <h4 tabindex="-1">${selfLink(r.title, { route: routeAnchor(r) })}</h4>
      </div>
      <p class="api-op-call"><span class="api-method m-${r.method}">${r.method}</span><code class="api-path">${apiPathHtml(r.path)}</code><button type="button" class="copy-btn api-copy-path" data-copy="${concretePath(r.path)}" data-copy-word="" aria-label="Copy path" title="Copy path">${copyFace(false, "")}</button></p>
      <div class="api-op-body">
        <div class="api-op-text">
          <p class="api-summary">${inline(r.summary)}</p>
          ${r.description ? prose(r.description, "api-desc") : null}
          ${apiQueryHtml(r.query)}
          ${apiBodyHtml(r.body, r.accepts)}
          ${apiReturnsHtml(r.returns, look.objects)}
          ${apiErrorsHtml(r.errors, look.meanings)}
        </div>
        <div class="api-op-code">
          ${apiExample("Request", r.example?.request)}
          ${apiExample("Response", r.example?.response)}
          ${apiCurl(r)}
        </div>
      </div>
    </article></li>`;
}
/** A resource's routes within a tier, in the order the tier lists them. */
const routesIn = (g: ReferenceGroup, res: ReferenceResource) =>
  g.routes.filter((r) => r.resource === res.key);
/** A cell short enough for a value's own line (a severity, the fields it carries). */
const SHORT_CELL = 80;
/**
 * A table of a field's values (the condition kinds), set as the sections' rows rather than a
 * grid: each value's name with its short cells beside it, each under its column's name, and its
 * long ones (what it means, what settles it) as lines beneath, the second and later labelled,
 * so no column squeezes another and nothing scrolls sideways.
 */
function apiTableHtml(t: ReferenceTable): Html {
  const short = t.columns.map(
    (_, i) => i > 0 && t.rows.every((r) => (r[i] ?? "").length <= SHORT_CELL),
  );
  const firstLong = t.columns.findIndex((_, i) => i > 0 && !short[i]);
  const rows = t.rows.map((r) => {
    const code = /^`([^`]+)`$/.exec(r[0] ?? "")?.[1];
    const meta = t.columns.flatMap((c, i) =>
      short[i]
        ? [
            html`<span class="api-row-meta"><span class="api-row-key">${c}</span> ${inline(r[i] ?? "")}</span>`,
          ]
        : [],
    );
    const lines = t.columns.flatMap((c, i) =>
      i > 0 && !short[i]
        ? [
            html`<div class="api-row-desc">${i === firstLong ? null : html`<span class="api-row-key">${c}:</span> `}${inline(r[i] ?? "")}</div>`,
          ]
        : [],
    );
    return html`<div class="api-row"><div class="api-row-head"><code class="api-row-name">${code === undefined ? inline(r[0] ?? "") : breakable(code)}</code>${meta}</div>${lines}</div>`;
  });
  return section(
    t.title,
    html`<div class="api-list api-value-rows">${rows}</div>`,
    null,
    prose(t.description, "api-prose"),
  );
}
// An object its resource's routes return, first under the resource as Stripe puts it, laid
// out like a route: its fields on the left, its example beside them.
function apiObjectHtml(o: ReferenceObject): Html {
  return html`<article class="api-op api-object" id="api-objects-${o.key}" data-sec="objects-${o.key}">
      <div class="api-op-head"><h4 tabindex="-1">${selfLink(o.title, { sec: `objects-${o.key}` })}</h4></div>
      <p class="api-op-call"><span class="api-method m-OBJECT">Object</span><span class="api-path">${o.fields.length} ${o.fields.length === 1 ? "field" : "fields"}</span></p>
      <div class="api-op-body">
        <div class="api-op-text">
          ${prose(o.description, "api-prose")}
          ${apiFieldsTable(o.fields)}
          ${(o.tables ?? []).map(apiTableHtml)}
        </div>
        <div class="api-op-code">${apiExample("Example", o.example)}</div>
      </div>
    </article>`;
}
function apiResourceHtml(g: ReferenceGroup, res: ReferenceResource, look: Lookups): Html {
  const sec = `${g.access}-${res.key}`;
  const routes = routesIn(g, res);
  const objects = look.heads.get(sec) ?? [];
  return html`<div class="api-res" id="api-${sec}" data-sec="${sec}">
      <div class="api-res-head"><h3 tabindex="-1">${selfLink(res.title, { sec })}</h3></div>
      ${objects.map(apiObjectHtml)}
      <ul class="api-rows">${routes.map((r) => apiRouteHtml(r, look))}</ul>
    </div>`;
}
function apiSectionHtml(g: ReferenceGroup, look: Lookups): Html {
  return html`<section class="api-section" id="api-${g.access}" data-tier="${g.access}">
      <h2 tabindex="-1">${selfLink(g.title, { sec: g.access })}</h2>
      <p class="api-blurb muted">${inline(g.blurb)}</p>
      ${g.resources.map((res) => apiResourceHtml(g, res, look))}
    </section>`;
}
// The refusals any route can give, which no route lists as its own, each with what it means.
function apiSharedRefusalsHtml(ref: ReferenceResponse): Html | null {
  const shared = sharedRefusals(ref);
  if (!shared.length) {
    return null;
  }
  // No next move here, unlike a route's refusals: for these the status and the line already say
  // it (sign in, fix the request, fix the deployment). The Markdown keeps it, for Claude to act on.
  const rows = shared.map((c) => ledgerRow(c.status, breakable(c.code), null, inline(c.meaning)));
  return section(
    "Refusals any route can give",
    html`<div class="api-ledger api-refusals">${rows}</div>`,
  );
}
// The topics every route shares, before the routes. The filter matches a topic as a whole, by
// its title, and Errors by the refusals any route can give too, so a pasted code no route
// lists still finds what it means; every other code finds the routes that give it.
function apiOverviewHtml(ref: ReferenceResponse): Html {
  const codes = sharedRefusals(ref).map((c) => c.code);
  const concept = (c: ReferenceConcept) =>
    html`<div class="api-res" id="api-overview-${c.key}" data-sec="overview-${c.key}" data-hay="${[c.title, ...(c.key === "errors" ? codes : [])].join(" ").toLowerCase()}">
      <div class="api-res-head"><h3 tabindex="-1">${selfLink(c.title, { sec: `overview-${c.key}` })}</h3></div>
      ${prose(c.text, "api-prose")}
      ${c.key === "errors" ? apiStatusesHtml(ref.statuses) : null}
      ${c.fields?.length ? section(c.key === "errors" ? "The error body" : "Fields", apiFieldsTable(c.fields)) : null}
      ${c.key === "errors" ? apiSharedRefusalsHtml(ref) : null}
    </div>`;
  // The topics follow the page's own introduction, which the rail's Introduction names.
  return html`<section class="api-section" id="api-overview" data-tier="overview">
      ${ref.concepts.map(concept)}
    </section>`;
}
// Every status the API answers, in the same ledger as the refusals: the status, its name, and
// what it means here.
function apiStatusesHtml(statuses: readonly ReferenceStatus[]): Html {
  const rows = statuses.map((s) => ledgerRow(s.status, html`${s.name}`, null, inline(s.meaning)));
  return section("Status codes", html`<div class="api-ledger api-statuses">${rows}</div>`);
}
// The rail: the topics, then each tier, each with its resources and, under each resource, its
// objects and routes by name, so the rail is the whole page's contents as Stripe's is. Only the
// resource the reader is in shows its routes (spyRail opens it), and a filter shows every match,
// so the rail stays short enough to move by. A tier with one resource lists its routes under the
// tier itself.
function apiNavHtml(ref: ReferenceResponse, look: Lookups): Html {
  const part = (sec: string, title: string) =>
    html`<a href="#/api-reference/${sec}" class="api-nav-res" data-sec="${sec}">${title}</a>`;
  const ops = (g: ReferenceGroup, res: ReferenceResource) =>
    html`<div class="api-nav-ops" data-of="${g.access}-${res.key}">${[
      ...(look.heads.get(`${g.access}-${res.key}`) ?? []).map(
        (o) =>
          html`<a href="#/api-reference/objects-${o.key}" class="api-nav-op" data-sec="objects-${o.key}">${o.title}</a>`,
      ),
      ...routesIn(g, res).map(
        (r) =>
          html`<a href="#/api-reference/${routeAnchor(r)}" class="api-nav-op" data-route="${routeAnchor(r)}">${r.title}</a>`,
      ),
    ]}</div>`;
  return html`<a href="#/api-reference" class="api-nav-tier" data-sec="overview" data-tier="overview">Introduction</a>${ref.concepts.map(
    (c) => part(`overview-${c.key}`, c.title),
  )}${ref.groups.map(
    (g) =>
      html`<a href="#/api-reference/${g.access}" class="api-nav-tier" data-sec="${g.access}" data-tier="${g.access}">${g.title}</a>${g.resources.map(
        (res) => [
          g.resources.length > 1 ? part(`${g.access}-${res.key}`, res.title) : null,
          ops(g, res),
        ],
      )}`,
  )}`;
}

/**
 * Whether a typed or pasted address is a call to a route's path: a full URL or a path, any
 * query or fragment dropped, matching segment for segment, a `:param` segment matching any one.
 */
function callsPath(term: string, path: string): boolean {
  const at = term.replace(/^[a-z]+:\/\/[^/]*/, "").replace(/[?#].*$/, "");
  if (!at.startsWith("/")) {
    return false;
  }
  const want = at.replace(/(.)\/+$/, "$1").split("/");
  const have = path.split("/");
  return (
    want.length === have.length &&
    have.every((seg, i) => (seg.startsWith(":") ? want[i] !== "" : seg === want[i]))
  );
}
/** Whether a route row or a topic holds a word of the query: in its hay, or as a call to its path. */
function holds(el: HTMLElement, word: string): boolean {
  const path = el.dataset.path;
  return (el.dataset.hay ?? "").includes(word) || (path !== undefined && callsPath(word, path));
}

/**
 * Show only the routes and topics that hold every word of the query (routeHay, callsPath), with
 * the resources, tiers, and rail links that still hold one. An empty query shows everything.
 * The last tier still shown is marked, so it keeps the room to scroll up under the bar that the
 * last tier has.
 */
function applyFilter(query: string, navEl: HTMLElement, contentEl: HTMLElement): void {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  navEl.classList.toggle("filtering", terms.length > 0);
  let shown = 0;
  for (const sec of $$<HTMLElement>(".api-section", contentEl)) {
    let inTier = 0;
    for (const res of $$<HTMLElement>(".api-res", sec)) {
      // A topic matches as a whole; a resource by its routes.
      const topic = res.dataset.hay !== undefined;
      let inRes = 0;
      for (const item of topic ? [res] : $$<HTMLElement>("li[data-hay]", res)) {
        const hit = terms.every((w) => holds(item, w));
        item.hidden = !hit;
        inRes += hit ? 1 : 0;
        const opLink = item.dataset.route
          ? navEl.querySelector<HTMLElement>(`a[data-route="${item.dataset.route}"]`)
          : null;
        if (opLink) {
          opLink.hidden = !hit;
        }
      }
      res.hidden = inRes === 0;
      // An object's rail link follows its resource: the filter matches routes, not objects, so
      // an object is listed only while its resource still holds a match.
      for (const obj of $$<HTMLElement>(
        `.api-nav-ops[data-of="${res.dataset.sec}"] a[data-sec]`,
        navEl,
      )) {
        obj.hidden = terms.length > 0 && inRes === 0;
      }
      const link = navEl.querySelector<HTMLElement>(`a[data-sec="${res.dataset.sec}"]`);
      if (link) {
        link.hidden = inRes === 0;
      }
      inTier += inRes;
    }
    sec.hidden = inTier === 0;
    const tierLink = navEl.querySelector<HTMLElement>(`a[data-tier="${sec.dataset.tier}"]`);
    if (tierLink) {
      tierLink.hidden = inTier === 0;
    }
    shown += inTier;
  }
  const sections = $$<HTMLElement>(".api-section", contentEl);
  const lastShown = sections.filter((sec) => !sec.hidden).at(-1);
  for (const sec of sections) {
    sec.classList.toggle("api-last", sec === lastShown);
  }
  $<HTMLElement>("#apiEmpty", contentEl).hidden = shown > 0;
}

/**
 * Highlight the rail link for what the reader is in, and put its address in the bar: the last
 * heading (a tier, a resource, an object, or a route) scrolled above a line just under the
 * sticky resource heading, or the last one once the page is at its bottom, the reference's own
 * address at its top. Only the reader's scrolling moves the address (`follow`), never a render
 * or a filter, so a link the page was opened with stays in the bar; it changes with no history
 * entry, so Back still leaves the reference. A part the rail doesn't show (a phone's rail is the tier chips alone) hands the
 * highlight to what holds it.
 */
function spyRail(navEl: HTMLElement, contentEl: HTMLElement, follow: boolean): void {
  // Measured, not assumed, as the docs' spy does: large-text zoom can push the bar taller.
  // Just under the bar, so a jump to a resource keeps it current: its heading is shorter than
  // a looser line, which would hand the address to the object or route beneath it.
  const line = ($(".room-bar").getBoundingClientRect().height || 54) + 8;
  const marks = $$(".api-section, .api-res, .api-object, li[data-route]", contentEl).filter(
    (el) => !el.closest("[hidden]"),
  );
  const atBottom =
    window.scrollY > 0 &&
    Math.ceil(window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight;
  let current: HTMLElement | undefined;
  for (const el of marks) {
    if (atBottom || el.getBoundingClientRect().top <= line) {
      current = el;
    } else {
      break;
    }
  }
  const shown = $$("a[data-sec], a[data-route]", navEl).filter(
    (a) => !a.hidden && getComputedStyle(a).display !== "none",
  );
  const linkFor = (el: HTMLElement | undefined | null): HTMLElement | undefined => {
    if (!el) {
      return undefined;
    }
    const own = el.dataset.route
      ? shown.find((a) => a.dataset.route === el.dataset.route)
      : shown.find((a) => a.dataset.sec === (el.dataset.sec ?? el.dataset.tier));
    return own ?? linkFor(el.parentElement?.closest<HTMLElement>(".api-res, .api-section"));
  };
  // Only the resource the reader is in lists its routes in the rail.
  const inRes = current?.closest<HTMLElement>(".api-res")?.dataset.sec;
  for (const ops of $$(".api-nav-ops", navEl)) {
    ops.classList.toggle("open", ops.dataset.of === inRes);
  }
  // Above the first heading, the rail lights its first link, as it always has.
  const target = linkFor(current ?? marks[0]);
  for (const a of $$("a[data-sec], a[data-route]", navEl)) {
    a.classList.toggle("active", a === target);
  }
  // Keep the lit link in the rail's view as the page moves under it.
  const rail = navEl.closest<HTMLElement>(".rail-inner");
  if (target && rail && rail.scrollHeight > rail.clientHeight) {
    const t = target.getBoundingClientRect();
    const r = rail.getBoundingClientRect();
    if (t.top < r.top + 40 || t.bottom > r.bottom - 40) {
      rail.scrollTop += t.top - r.top - r.height / 3;
    }
  }
  const at = current?.dataset.route ?? current?.dataset.sec ?? current?.dataset.tier;
  const address =
    at && at !== "overview" && window.scrollY > 0 ? `#/api-reference/${at}` : "#/api-reference";
  if (follow && location.hash !== address) {
    history.replaceState(history.state, "", address);
  }
}

/** The part of the page a section address names; the Introduction is the page's own head. */
function part(sec: string): HTMLElement | null {
  return document.getElementById(sec === "overview" ? "api-intro" : `api-${sec}`);
}

/**
 * Bring what an address names into view, and the reader's focus with it, so the keyboard and a
 * screen reader carry on from there rather than from the link: a route or an object opened with
 * focus on its line, a tier or a resource with focus on its heading.
 */
function reveal(target: HTMLElement): void {
  // The Introduction is the page's own top, above the sticky bar's line, so it scrolls to 0
  // rather than putting the title under the bar.
  if (target.id === "api-intro") {
    window.scrollTo(0, 0);
  } else {
    target.scrollIntoView({ block: "start" });
  }
  const focus = target.querySelector<HTMLElement>(
    ":scope > h1, :scope > h2, :scope > .api-res-head h3, :scope > .api-op-head h4, :scope > article > .api-op-head h4",
  );
  focus?.focus({ preventScroll: true });
}

/**
 * The API reference room. `anchor` (from `#/api-reference/<anchor>`) names what to bring into view
 * once the reference is in: a route (`cancel-send`), opened, or a part of the page
 * the rail and Returns links name (`admin-sends`, `objects-send`, `overview-errors`). One that
 * names nothing opens the reference at its top.
 */
export async function renderReference(
  root: HTMLElement,
  signal: AbortSignal,
  anchor?: string,
): Promise<void> {
  setTitle(signal, "API reference");
  setHtml(
    root,
    roomShell(
      "api-reference",
      html`<div class="toc-label">API</div><nav class="api-nav" id="apiNav" aria-label="API sections"></nav>`,
      html`<div class="api-content" id="apiContent"><p class="muted">Loading…</p></div>`,
    ),
  );
  const navEl = $("#apiNav");
  const contentEl = $("#apiContent");
  // Delegate clicks synchronously with one listener each on the stable nav and page, so they
  // survive the async fill below: a rail click, or a route's link to an object, jumps there
  // in place. Each is a real link to its address, so a modified click (a new tab) is the
  // browser's, and the address bar follows the jump without a hashchange that would render
  // the room again.
  const jump = (ev: MouseEvent) => {
    const a =
      ev.target instanceof Element
        ? ev.target.closest<HTMLElement>("a[data-sec], a[data-route]")
        : null;
    const target = a?.dataset.route
      ? document.getElementById(`route-${a.dataset.route}`)
      : a?.dataset.sec
        ? part(a.dataset.sec)
        : null;
    if (!target || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) {
      return;
    }
    ev.preventDefault();
    // A filter may have hidden what the link points at (a route's object, under another
    // resource): clear it, rather than leave the click to do nothing. Nothing found starts
    // over from the Introduction, so its link clears the filter too.
    if (target.closest("[hidden]") || a?.closest("#apiEmpty")) {
      filterTo("");
    }
    history.replaceState(history.state, "", a?.getAttribute("href") ?? location.hash);
    reveal(target);
    // Light the rail now, not only on the scroll the jump causes, which a page that isn't in
    // view may never get.
    spyRail(navEl, contentEl, false);
  };
  navEl.addEventListener("click", jump);
  contentEl.addEventListener("click", jump);
  let ref: ReferenceResponse;
  try {
    ref = await api<ReferenceResponse>("/api/reference", { signal });
  } catch (e) {
    renderError(contentEl, describeError(e), () =>
      mount((r, sig) => renderReference(r, sig, anchor)),
    );
    return;
  }
  const look: Lookups = {
    meanings: new Map(ref.refusals.flatMap((g) => g.codes.map((c) => [c.code, c.meaning]))),
    objects: new Map(ref.objects.map((o) => [o.key, o.title])),
    heads: objectHeads(ref),
  };

  setHtml(navEl, apiNavHtml(ref, look));
  setHtml(
    contentEl,
    html`<header class="api-head" id="api-intro"><h1 tabindex="-1">API reference</h1><p class="muted">Every endpoint this instance serves, the one API the web editor and Claude both call. It's read from the running code, so it always matches this version. Base URL <code>${location.origin}</code>.</p><div class="api-filter">${icon("search")}<input type="search" id="apiFilter" placeholder="Filter by name, path, URL, or error code" autocomplete="off" aria-label="Filter routes" aria-keyshortcuts="/"><kbd aria-hidden="true">/</kbd><button type="button" class="icon api-filter-clear" id="apiFilterClear" aria-label="Clear filter" hidden>${icon("x")}</button></div></header>${apiOverviewHtml(ref)}${ref.groups.map((g) => apiSectionHtml(g, look))}<p class="api-empty muted" id="apiEmpty" hidden>Nothing matches. Try a path segment like <code>sends</code>, a method like <code>DELETE</code>, or a code like <code>stale_revision</code>, or start from the <a href="#/api-reference" data-sec="overview">Introduction</a>.</p>`,
  );
  const filterEl = $<HTMLInputElement>("#apiFilter");
  const clearEl = $("#apiFilterClear");
  const spy = () => spyRail(navEl, contentEl, false);
  const filterTo = (query: string) => {
    filterEl.value = query;
    clearEl.hidden = query === "";
    applyFilter(query, navEl, contentEl);
    spy();
  };
  filterEl.addEventListener("input", () => filterTo(filterEl.value));
  clearEl.addEventListener("click", () => {
    filterTo("");
    filterEl.focus();
  });
  // A code block's Copy puts its plain text (the example, or the curl command) on the
  // clipboard and says so where it sits (ui/copy.ts).
  wireCopy(contentEl);
  // "/" jumps to the filter from anywhere in the room (unless typing elsewhere); Escape
  // in the filter clears it. Bound to the view, so it ends when the room does.
  document.addEventListener(
    "keydown",
    (ev) => {
      const typing =
        ev.target instanceof HTMLElement &&
        (ev.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName));
      if (ev.key === "/" && !typing && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        filterEl.focus();
      } else if (ev.key === "Escape" && ev.target === filterEl && filterEl.value) {
        filterTo("");
      }
    },
    { signal },
  );

  // Mark the last tier (the filter keeps it current from here).
  applyFilter("", navEl, contentEl);
  // The rail follows the reading position, and the filter, which moves every heading.
  window.addEventListener("scroll", () => spyRail(navEl, contentEl, true), {
    passive: true,
    signal,
  });
  // Its own page: start at the top, not wherever the last doc was scrolled to, or at the
  // route the address names.
  window.scrollTo(0, 0);
  const target = anchor ? (document.getElementById(`route-${anchor}`) ?? part(anchor)) : null;
  if (target) {
    reveal(target);
  }
  spy();
}
