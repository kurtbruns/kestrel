// Settings' Ways to subscribe section: the public subscribe page's address and a form to
// paste into the publisher's own site. Both post to the public /subscribe and start the
// double opt-in, never an auto-confirm (I1).

import { connectProviderLink } from "../deployment";
import { copyButton, copyFace, wireCopy } from "../ui/copy";
import { $, $$ } from "../ui/dom";
import { escapeHtml, type Html, html, setHtml } from "../ui/html";
import { type IconName, icon } from "../ui/icons";
import { chip, type SectionHandle, type SettingsPage, secHead } from "./page";

type EmbedMode = "plain" | "styled";

/** The embed's heading: "Subscribe to <name>", or "Subscribe" with no name (SPEC §9). */
function embedHeading(name: string): string {
  return name ? `Subscribe to ${name}` : "Subscribe";
}

/** The snippet a publisher pastes into their own page. It is text here (shown in a code
 *  block and copied), escaped for the page it will land in. */
export function buildEmbed(mode: EmbedMode, name: string, appOrigin: string): string {
  const heading = escapeHtml(embedHeading(name));
  const action = `${escapeHtml(appOrigin)}/subscribe`;
  if (mode === "styled") {
    // The hosted subscribe page's look, carried inline: a serif headline (Georgia, the
    // reader pages' own fallback, so it needs no web font) over a sans body, in the reader
    // pages' ink and muted colors. The headline inherits its color from the host page, and
    // the field's border is a step darker than the reader pages' line so it still shows on
    // a host page of any background. The apostrophe is plain ASCII, so the snippet reads
    // right whatever encoding the host page declares.
    return (
      `<form action="${action}" method="post" style="max-width:460px;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">\n` +
      `  <div style="font:600 22px/1.2 Georgia,'Times New Roman',serif;letter-spacing:-0.01em;margin-bottom:12px">${heading}</div>\n` +
      `  <div style="display:flex;gap:10px;flex-wrap:wrap">\n` +
      `    <input type="email" name="email" required placeholder="you@example.com" aria-label="Email address" style="flex:1 1 220px;padding:11px 13px;border:1px solid #d6d3cc;border-radius:9px;background:#fff;color:#1b1a17;font:inherit">\n` +
      `    <button type="submit" style="padding:11px 20px;border:1px solid #1b1a17;border-radius:9px;background:#1b1a17;color:#fbfbfa;font:inherit;font-size:15px;font-weight:600;cursor:pointer;white-space:nowrap">Subscribe</button>\n` +
      `  </div>\n` +
      `  <p style="margin:12px 0 0;font-size:12.5px;color:#6b6a63">We’ll email you a link to confirm. Unsubscribe anytime.</p>\n` +
      `</form>`
    );
  }
  return (
    `<form action="${action}" method="post">\n` +
    `  <label>\n` +
    `    ${heading}\n` +
    `    <input type="email" name="email" placeholder="you@example.com" required>\n` +
    `  </label>\n` +
    `  <button type="submit">Subscribe</button>\n` +
    `</form>`
  );
}

/** The snippet as it will look on the publisher's site: a mockup, inert. The styled form
 *  wears the hosted page's look; the plain one is laid out as its markup renders, with
 *  the browser's own controls, since bare markup gets the site's styles or none. */
function embedPreview(mode: EmbedMode, name: string): Html {
  const heading = embedHeading(name);
  if (mode === "styled") {
    return html`<form class="set-pf-styled"><span class="l">${heading}</span><div class="rowf"><input type="email" placeholder="you@example.com" disabled><button type="button" class="sub-btn" tabindex="-1">Subscribe</button></div><p class="set-pf-fine">We’ll email you a link to confirm. Unsubscribe anytime.</p></form>`;
  }
  return html`<form class="set-pf-plain"><label>${heading} <input type="email" placeholder="you@example.com" disabled></label> <button type="button" tabindex="-1">Subscribe</button></form>`;
}

function appOriginOf(page: SettingsPage): string {
  return page.data.deployment.appOrigin || location.origin;
}

/** The page's line names the publication only when it has a name, since the page then
 *  reads "Subscribe" (SPEC §9). */
function pageLine(name: string): string {
  return name
    ? "A public page with your publication’s name and a sign-up form ready to go."
    : "A public page with a sign-up form ready to go.";
}

/** One way to subscribe, a band of the section's card: its glyph and title, its line,
 *  and any control at the head's right end, then what it offers. The two ways share
 *  this head so they read as parallel options. */
function way(
  glyph: IconName,
  title: string,
  line: Html,
  body: Html,
  control: Html | null = null,
): Html {
  return html`<div class="set-way"><div class="set-way-head"><div class="set-way-name"><h3 class="set-way-title">${icon(glyph)}${title}</h3><p class="set-way-line">${line}</p></div>${control}</div>${body}</div>`;
}

export function subscribeSection(page: SettingsPage): Html {
  const subscribeUrl = `${appOriginOf(page)}/subscribe`;
  return html`
    <section class="set-sec set-sec-subscribe">
      ${secHead("Ways to subscribe", chip("copyout", "Copy-out"))}
      <p class="set-lede">Two ways for readers to join your list. Either way, a reader is added only once they confirm by email.</p>
      ${
        // Signups are closed while no provider is connected (SPEC §9): the page says so and
        // a form takes no address. The address and the code stay, ready for when they open.
        page.data.deployment.provider === "none"
          ? html`<div class="health amber set-sub-not-connected" role="status"><span class="health-dot">⚠️</span><div><span>No email provider connected, so signups aren’t open yet: the page below says so, and the form takes no address. ${connectProviderLink()} to open signups.</span></div></div>`
          : null
      }
      <div class="set-card">
      ${way(
        "link",
        "Share the page",
        html`<span id="subscribePageLine"></span>`,
        html`<div class="set-way-body set-way-addr"><code class="set-addr">${subscribeUrl}</code>${copyButton(subscribeUrl, "Copy the subscribe page’s address")}<a class="ghost-link" href="${subscribeUrl}" target="_blank" rel="noopener">Open&nbsp;↗</a></div>`,
      )}
      ${way(
        "code",
        "Embed a form",
        html`Put a sign-up form on another site you own.`,
        html`<div class="set-embed">
            <div class="set-embed-preview" id="embedPreview"></div>
            <pre class="set-embed-code"><code id="embedCode"></code></pre>
          </div>
          <div class="set-embed-foot" id="embedCopy"></div>`,
        html`<span class="set-wtog" role="group" aria-label="Snippet style">
            <button type="button" class="wtog-btn" data-embed="styled" aria-pressed="true">Styled</button>
            <button type="button" class="wtog-btn" data-embed="plain" aria-pressed="false">Plain</button>
          </span>`,
      )}
      </div>
    </section>`;
}

/** The embed's one act, copying the snippet, as a Secondary button rather than the quiet
 *  Copy a code block wears, since here copying is what the band is for (DESIGN §7). */
function embedCopy(mode: EmbedMode, code: string): Html {
  const variant = mode === "styled" ? "Styled" : "Plain";
  return html`<button type="button" class="secondary set-embed-copy" data-copy="${code}" data-copy-word="Copy HTML" aria-label="Copy HTML, ${variant} form">${copyFace(false, "Copy HTML")}</button>`;
}

/** The Plain/Styled toggle drives the code, the rendered preview, and the Copy payload;
 *  the name follows the live identity field. */
export function mountSubscribe(root: HTMLElement, page: SettingsPage): SectionHandle {
  const appOrigin = appOriginOf(page);
  const codeEl = $("#embedCode", root);
  const copyEl = $("#embedCopy", root);
  const previewEl = $("#embedPreview", root);
  const lineEl = $("#subscribePageLine", root);
  // Styled first: it pastes in looking like the hosted page anywhere, so the first form a
  // publisher sees is their publication's, and Plain is the choice for one who'll style it.
  let mode: EmbedMode = "styled";
  const name = () => page.state.name || page.fromDisplay;
  const rebuild = () => {
    const code = buildEmbed(mode, name(), appOrigin);
    codeEl.textContent = code;
    setHtml(copyEl, embedCopy(mode, code));
    setHtml(previewEl, embedPreview(mode, name()));
    lineEl.textContent = pageLine(name());
  };
  const modeButtons = $$("[data-embed]", root);
  for (const b of modeButtons) {
    b.onclick = () => {
      mode = b.dataset.embed === "styled" ? "styled" : "plain";
      for (const o of modeButtons) {
        o.setAttribute("aria-pressed", String(o.dataset.embed === mode));
      }
      rebuild();
    };
  }
  wireCopy($(".set-sec-subscribe", root));
  rebuild();
  // The page repaints every section on any change, but the section shows only the name:
  // rebuilt for anything else, its Copy would lose a check it had just shown.
  let shownName = name();
  return {
    repaint() {
      if (name() !== shownName) {
        shownName = name();
        rebuild();
      }
    },
  };
}
