// One subscriber's page: how they joined, their suppression, why they left, and every send
// their address was in, with the acts their roster row offers.

import type { ImportRecord, ImportRecordResponse } from "../../shared/imports";
import { CAUSE_MEANING, FLAG_MEANING, SUPPRESSION_FLAG } from "../../shared/subscriber_meanings";
import type {
  Subscriber,
  SubscriberDeliveriesResponse,
  SubscriberDelivery,
  SubscriberResponse,
  SuppressionReason,
  UnsubscribeCause,
} from "../../shared/subscribers";
import { api, describeError } from "../api";
import { setTitle } from "../lifecycle";
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
 * the roster's legend gives, for this person: their status and flag as the list draws them and
 * whether they receive posts, then how they joined, their suppression, why they left, and their
 * sends (SPEC §8). The acts are the row menu's, with the same dialogs. After one lands the page
 * reads itself again in place, keeping what it showed until the answer arrives, and puts focus
 * on its title, since the button that opened the dialog may be gone (DESIGN §11).
 */
export async function renderSubscriber(
  id: string,
  root: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  setTitle(signal, "Subscriber");
  setHtml(root, html`${BACK}<p class="muted">Loading…</p>`);
  // The route's segment is the server's id, but it reaches an API path only encoded.
  const path = `/api/subscribers/${encodeURIComponent(id)}`;

  async function load(afterAct: boolean): Promise<void> {
    let sub: Subscriber;
    let sends: SubscriberDeliveriesResponse;
    let record: ImportRecord | null;
    try {
      const one = api<SubscriberResponse>(path, { signal });
      // The import that brought them is read as soon as the subscriber names it, beside their
      // sends; it only adds rows, so the page shows without them if it can't be read.
      const imported = one.then(({ subscriber }) =>
        subscriber.import_id === null
          ? null
          : api<ImportRecordResponse>(`/api/imports/${encodeURIComponent(subscriber.import_id)}`, {
              signal,
            }).then(
              (r) => r.import,
              () => null,
            ),
      );
      const [first, firstPage, importRecord] = await Promise.all([
        one,
        api<SubscriberDeliveriesResponse>(`${path}/deliveries`, { signal }),
        imported,
      ]);
      sub = first.subscriber;
      sends = firstPage;
      record = importRecord;
    } catch (e) {
      const body = document.createElement("div");
      setHtml(root, BACK);
      root.append(body);
      renderError(body, describeError(e), () => {
        setHtml(root, html`${BACK}<p class="muted">Loading…</p>`);
        void load(false);
      });
      return;
    }
    if (signal.aborted) {
      return;
    }
    paint(sub, sends, record);
    if (afterAct) {
      $<HTMLElement>("h1.sub-title", root).focus();
    }
  }

  function paint(
    sub: Subscriber,
    sends: SubscriberDeliveriesResponse,
    record: ImportRecord | null,
  ): void {
    const acts = subscriberActs(sub, () => void load(true), signal);
    const erased = isErased(sub);
    setHtml(
      root,
      html`${BACK}
      <div class="spread page-head sub-page-head">
        <div class="sub-page-title"><h1 class="sub-title" tabindex="-1">${sub.email}</h1><span class="sub-pills">${statusBadge(sub)}${suppressionFlag(sub)}</span></div>
        <span class="row sub-acts">${acts.map(
          (a, i) =>
            html`<button type="button" class="${a.danger ? "danger-subtle" : ""}" data-act="${i}">${a.label}…</button>`,
        )}</span>
      </div>
      <p class="sub-receives${sub.receives_posts ? " yes" : ""}">${receivesLine(sub)}</p>
      ${erased ? null : joinedSection(sub, record)}
      ${suppressionSection(sub)}
      ${sub.unsubscribe_cause ? leftSection(sub) : null}
      <section class="sub-sec sub-sends" aria-labelledby="subSendsTitle">
        <h2 class="rec-part-title" id="subSendsTitle">Sends</h2>
        <div id="subSends"></div>
        <div id="subMore"></div>
      </section>`,
    );
    for (const b of $$<HTMLButtonElement>("[data-act]", root)) {
      b.onclick = () => acts[Number(b.dataset.act)]?.onClick();
    }
    // A complaint's send is linked once it is among the sends shown, whichever page brings it.
    const complaintLine = root.querySelector<HTMLElement>("#subComplaint");
    const linkComplaint = (deliveries: SubscriberDelivery[]) => {
      const d = deliveries.find((x) => x.delivery.event === "complained");
      if (complaintLine?.hidden && d) {
        setHtml(
          complaintLine,
          html`The report was about <a href="#/sent/${d.send.id}">${d.send.subject || "an untitled post"}</a>.`,
        );
        complaintLine.hidden = false;
      }
    };
    paintSends(root, path, sends, erased, signal, linkComplaint);
  }

  await load(false);
}

/**
 * Whether they receive your posts, which the server decides (`receives_posts`), and when they
 * don't, every reason in the words of their status and suppression, so the page answers "did
 * they get my post?" before anything else.
 */
function receivesLine(sub: Subscriber): string {
  if (sub.receives_posts) {
    return "Receives your posts.";
  }
  const why: string[] = [];
  if (sub.status === "pending") {
    why.push("they haven’t confirmed");
  } else if (sub.status === "unsubscribed") {
    why.push(`they left the list on ${fmt(sub.unsubscribed_at)}`);
  }
  if (sub.suppression) {
    why.push(
      SUPPRESSION_FLAG[sub.suppression.reason] === "bounced"
        ? "the address bounced"
        : "the address is blocked",
    );
  }
  return why.length > 0 ? `Not sent your posts: ${why.join(", and ")}.` : "Not sent your posts.";
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
    ${sub.import_id !== null ? html`<p class="sub-note">The origin, opt-in, confirmation date, and evidence are what the imported file said, not something Kestrel recorded itself.</p>` : null}
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
    body = html`<p class="muted">None.</p>`;
  } else {
    const flag = SUPPRESSION_FLAG[sup.reason];
    body = html`<p class="sub-sup-line"><span class="badge suppressed">${flag}</span> <span class="muted">since ${fmt(sup.created_at)}</span></p>
      <p class="sub-meaning">${flagMeaning(sub, sup.reason)}</p>
      ${sup.detail ? html`<dl class="sub-dl">${row("Detail", sup.detail)}</dl>` : null}`;
  }
  return html`<section class="card sub-sec" aria-labelledby="subSupTitle">
    <h2 class="rec-part-title" id="subSupTitle">Suppression</h2>
    ${body}
  </section>`;
}

/** Why someone left, said in the past for someone who has since signed up again, whose
 *  leaving no longer holds: the shared meanings describe someone still gone. */
const LEFT_BEFORE: Record<UnsubscribeCause, string> = {
  reader: "They had unsubscribed themselves, from the link or the button in your email.",
  publisher: "You had unsubscribed them, when they asked you to.",
  complaint: "They had reported your email as spam.",
  erased: "You had erased them at their request.",
  import: "The list you imported said they had left.",
};

/**
 * What the flag means for this address. The legend's words cover every case ("by you or at
 * the service it was imported from"); this page says which, where the record can tell: a
 * bounce seen here is the provider's, an imported one the previous service's, and a block on
 * someone who joined here is the publisher's. A block on an imported or erased person may
 * have come with the import, which the suppression doesn't record, so it keeps the legend's.
 */
function flagMeaning(sub: Subscriber, reason: SuppressionReason): string {
  switch (reason) {
    case "bounce":
      return "Your email provider reported that mail to this address failed. You can clear it.";
    case "import_bounce":
      return "Mail to this address failed at the service your list was imported from. You can clear it.";
    default:
      return sub.import_id === null && !isErased(sub)
        ? "You blocked this address. You can unblock it."
        : FLAG_MEANING[SUPPRESSION_FLAG[reason]];
  }
}

/**
 * Why they left (SPEC §7), in the words the API reference uses, and when; for a complaint, a
 * place for the send whose report it was, filled once that send is among the sends shown. An erasure keeps nothing else, so
 * an erased subscriber's page says only that they were erased and when. Someone who has signed
 * up again since reads it as what happened before, in the past tense, under "Left before".
 */
function leftSection(sub: Subscriber): Html | null {
  const cause = sub.unsubscribe_cause;
  if (!cause) {
    return null;
  }
  const returned = sub.status !== "unsubscribed";
  return html`<section class="card sub-sec" aria-labelledby="subLeftTitle">
    <h2 class="rec-part-title" id="subLeftTitle">${returned ? "Left before" : "Why they left"}</h2>
    <p class="sub-left-line"><span class="muted">Left ${fmt(sub.unsubscribed_at)}</span></p>
    <p class="sub-meaning">${returned ? LEFT_BEFORE[cause] : CAUSE_MEANING[cause]}</p>
    ${cause === "complaint" ? html`<p class="sub-meaning" id="subComplaint" hidden></p>` : null}
    ${sub.status === "pending" ? html`<p class="sub-meaning">They signed up again, and haven’t confirmed yet.</p>` : null}
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
  path: string,
  first: SubscriberDeliveriesResponse,
  erased: boolean,
  signal: AbortSignal,
  onPage: (deliveries: SubscriberDelivery[]) => void,
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
    onPage(page.deliveries);
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
              `${path}/deliveries?after=${encodeURIComponent(next)}`,
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
