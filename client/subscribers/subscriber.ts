// One subscriber's page: how they joined, their suppression, why they left, and every send
// their address was in, with the acts their roster row offers.

import type { ImportRecord, ImportRecordResponse } from "../../shared/imports";
import {
  CAUSE_LABEL,
  CAUSE_MEANING,
  FLAG_MEANING,
  SUPPRESSION_FLAG,
} from "../../shared/subscriber_meanings";
import type {
  Subscriber,
  SubscriberDeliveriesResponse,
  SubscriberDelivery,
  SubscriberResponse,
} from "../../shared/subscribers";
import { api, describeError } from "../api";
import { mount } from "../lifecycle";
import { deliveryOutcome } from "../sends/outcome";
import { $, $$ } from "../ui/dom";
import { fmt } from "../ui/format";
import { type Html, html, setHtml } from "../ui/html";
import { busy, renderError } from "../ui/widgets";
import { subscriberActs } from "./acts";
import { isErased, statusBadge, suppressionFlag } from "./labels";
import { evidenceText, importedBy, joinedVia, optInPhrase, originName } from "./provenance";

const BACK = html`<div class="editor-head"><a href="#/subscribers" class="back">← Subscribers</a></div>`;

/**
 * The page for one subscriber (DESIGN §3), at `#/subscribers/:id`. It shows the same meanings
 * the roster's legend gives, for this person: their status and flag as the list draws them,
 * then how they joined, their suppression, why they left, and their sends (SPEC §8). The acts
 * are the row menu's, with the same dialogs, and after one lands the page reads itself again.
 */
export async function renderSubscriber(
  id: string,
  root: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  const remount = () => {
    if (!signal.aborted) {
      mount((r, s) => renderSubscriber(id, r, s));
    }
  };
  setHtml(root, html`${BACK}<p class="muted">Loading…</p>`);
  let sub: Subscriber;
  let sends: SubscriberDeliveriesResponse;
  let record: ImportRecord | null = null;
  try {
    const [one, firstPage] = await Promise.all([
      api<SubscriberResponse>(`/api/subscribers/${id}`, { signal }),
      api<SubscriberDeliveriesResponse>(`/api/subscribers/${id}/deliveries`, { signal }),
    ]);
    sub = one.subscriber;
    sends = firstPage;
    if (sub.import_id !== null) {
      record = (await api<ImportRecordResponse>(`/api/imports/${sub.import_id}`, { signal }))
        .import;
    }
  } catch (e) {
    const body = document.createElement("div");
    setHtml(root, BACK);
    root.append(body);
    renderError(body, describeError(e), remount);
    return;
  }

  const acts = subscriberActs(sub, remount, signal);
  const erased = isErased(sub);
  setHtml(
    root,
    html`${BACK}
    <div class="spread page-head sub-page-head">
      <div class="sub-page-title"><h1 class="sub-title">${sub.email}</h1><span class="sub-pills">${statusBadge(sub)}${suppressionFlag(sub)}</span></div>
      <span class="row sub-acts">${acts.map(
        (a, i) =>
          html`<button type="button" class="${a.danger ? "danger-subtle" : ""}" data-act="${i}">${a.label}…</button>`,
      )}</span>
    </div>
    ${erased ? null : joinedSection(sub, record)}
    ${suppressionSection(sub)}
    ${sub.unsubscribe_cause ? leftSection(sub, sends.deliveries) : null}
    <section class="card sub-sec" aria-labelledby="subSendsTitle">
      <h2 class="rec-part-title" id="subSendsTitle">Sends</h2>
      <div id="subSends"></div>
      <div id="subMore"></div>
    </section>`,
  );
  for (const b of $$<HTMLButtonElement>("[data-act]", root)) {
    b.onclick = () => acts[Number(b.dataset.act)]?.onClick();
  }
  paintSends(root, id, sends, erased, signal);
}

function row(term: string, value: Html | string): Html {
  return html`<dt>${term}</dt><dd>${value}</dd>`;
}

/**
 * How they joined (SPEC §7): the way in, the import that brought them when one did (its
 * file, when and by whom, the attestation's version), when they joined and confirmed, and the
 * evidence. An import's file gives the origin, opt-in, confirmation date, and evidence, which
 * a line says, since Kestrel didn't record them itself.
 */
function joinedSection(sub: Subscriber, record: ImportRecord | null): Html {
  const evidence = evidenceText(sub.consent_evidence);
  const how =
    joinedVia(sub) ??
    (sub.status === "pending"
      ? "Signed up here, not confirmed yet"
      : "Signed up here, never confirmed");
  return html`<section class="card sub-sec" aria-labelledby="subJoinedTitle">
    <h2 class="rec-part-title" id="subJoinedTitle">How they joined</h2>
    <dl class="sub-dl">
      ${row("How they joined", how)}
      ${
        sub.import_id !== null
          ? html`${row("Origin", originName(sub.origin) ?? "Unknown")}
            ${row("Opt-in", optInPhrase(sub.opt_in))}
            ${
              record
                ? html`${row("Import", html`<code>${record.file_name}</code>`)}
                  ${row("Imported", `${fmt(record.created_at)}, by ${importedBy(record)}`)}
                  ${row("Attestation", record.attestation_version === null ? "None: the import confirmed no one" : `Version ${record.attestation_version}`)}`
                : null
            }`
          : null
      }
      ${row(
        // When the row was added here, as the roster's Joined column shows it. An import
        // records the file's own date (its confirmed_at, else its subscribed_at) as the
        // confirmation, which the note says is the file's.
        "Joined",
        fmt(sub.created_at),
      )}
      ${row("Confirmed", fmt(sub.confirmed_at))}
      ${row("Evidence", evidence ? html`<pre class="sub-evidence">${evidence}</pre>` : "None recorded")}
    </dl>
    ${sub.import_id !== null ? html`<p class="hint sub-note">The origin, opt-in, confirmation date, and evidence are what the imported file said, not something Kestrel recorded itself.</p>` : null}
  </section>`;
}

/**
 * The address's suppression as it stands (SPEC §7): its flag beside the shared meaning, the
 * provider's or publisher's words, and since when. Only the current one is kept, so the
 * section says what stands, not a history; past bounces show per send below.
 */
function suppressionSection(sub: Subscriber): Html {
  const sup = sub.suppression;
  let body: Html;
  if (!sup) {
    body = html`<p class="muted">None. Nothing on your side stops mail to this address.</p>`;
  } else {
    const flag = SUPPRESSION_FLAG[sup.reason];
    body = html`<p class="sub-sup-line"><span class="badge suppressed">${flag}</span> <span class="muted">since ${fmt(sup.created_at)}</span></p>
      <p class="sub-meaning">${FLAG_MEANING[flag]}${sup.reason === "import_bounce" ? " This one came from the service the list was imported from." : null}</p>
      ${sup.detail ? html`<dl class="sub-dl">${row("Detail", sup.detail)}</dl>` : null}`;
  }
  return html`<section class="card sub-sec" aria-labelledby="subSupTitle">
    <h2 class="rec-part-title" id="subSupTitle">Suppression</h2>
    ${body}
  </section>`;
}

/**
 * Why they left (SPEC §7), in the legend's words, and when; for a complaint, the send whose
 * report it was, when it is among the sends shown. An erasure keeps nothing else, so an
 * erased subscriber's page says only that they were erased and when.
 */
function leftSection(sub: Subscriber, deliveries: SubscriberDelivery[]): Html | null {
  const cause = sub.unsubscribe_cause;
  if (!cause) {
    return null;
  }
  const complaint =
    cause === "complaint" ? deliveries.find((d) => d.delivery.event === "complained") : undefined;
  const label = CAUSE_LABEL[cause];
  return html`<section class="card sub-sec" aria-labelledby="subLeftTitle">
    <h2 class="rec-part-title" id="subLeftTitle">Why they left</h2>
    <p class="sub-left-line"><strong>${label.charAt(0).toUpperCase()}${label.slice(1)}</strong> <span class="muted">${fmt(sub.unsubscribed_at)}</span></p>
    <p class="sub-meaning">${CAUSE_MEANING[cause]}</p>
    ${complaint ? html`<p>The report was about <a href="#/sent/${complaint.send.id}">${complaint.send.subject || "an untitled post"}</a>.</p>` : null}
    ${sub.status === "pending" ? html`<p class="muted">They signed up again and haven’t confirmed yet.</p>` : null}
  </section>`;
}

/**
 * The address's row on each send, newest first, a page at a time: the send, linking to its
 * record, its outcome in the record's words, and the detail and time the provider gave. An
 * erased person's rows carry a placeholder in place of the address, so none can be listed,
 * which the section says.
 */
function paintSends(
  root: HTMLElement,
  id: string,
  first: SubscriberDeliveriesResponse,
  erased: boolean,
  signal: AbortSignal,
): void {
  const list = $("#subSends", root);
  const more = $("#subMore", root);
  if (first.deliveries.length === 0) {
    setHtml(
      list,
      erased
        ? html`<p class="muted">Their past sends show an erased recipient in place of the address, so none is listed here.</p>`
        : html`<p class="muted">Not in any send yet.</p>`,
    );
    return;
  }
  setHtml(
    list,
    html`<div class="table-wrap"><table class="list-table sub-sends-table"><colgroup><col><col class="c-out"><col><col class="c-date"></colgroup><thead><tr><th>Send</th><th class="c-out">Outcome</th><th>Detail</th><th class="c-date">When</th></tr></thead><tbody></tbody></table></div>`,
  );
  const body = $("tbody", list);
  const add = (page: SubscriberDeliveriesResponse) => {
    const tmp = document.createElement("tbody");
    setHtml(tmp, html`${page.deliveries.map(sendRow)}`);
    body.append(...tmp.childNodes);
    paintMore(page.next);
  };
  const paintMore = (next: string | null) => {
    if (!next) {
      setHtml(more, html``);
      return;
    }
    setHtml(more, html`<button type="button" class="sub-more">Show more</button>`);
    const b = $<HTMLButtonElement>(".sub-more", more);
    b.onclick = () =>
      busy(b, "Loading…", async () => {
        try {
          add(
            await api<SubscriberDeliveriesResponse>(
              `/api/subscribers/${id}/deliveries?after=${encodeURIComponent(next)}`,
              { signal },
            ),
          );
        } catch (e) {
          renderError(more, describeError(e), () => paintMore(next));
        }
      });
  };
  add(first);
}

// What a skipped row means: it was left out when its turn came.
const SKIPPED = "Left out: unsubscribed or suppressed before it went";

function sendRow({ send, delivery }: SubscriberDelivery): Html {
  const o = deliveryOutcome(delivery);
  const detail =
    delivery.error ||
    delivery.event_detail ||
    (delivery.event === null && delivery.status === "skipped" ? SKIPPED : "");
  return html`<tr><td class="sub-send"><a href="#/sent/${send.id}">${send.subject || html`<em>untitled</em>`}</a><div class="muted">${fmt(send.fire_at)}</div></td><td><span class="rec-out"><span class="rec-sw sw-${o.sw}"></span>${o.label}</span></td><td class="muted">${detail || "—"}</td><td class="muted">${delivery.event_at ? fmt(delivery.event_at) : "—"}</td></tr>`;
}
