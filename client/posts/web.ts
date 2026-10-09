// The web-version preview: a post, or the template's sample post, as its public archive
// page will show it once sent (SPEC §5). Where a test email's view-in-browser link leads.

import type { WebPreviewTarget } from "../../shared/web_preview";
import { apiText } from "../api";
import { mount } from "../lifecycle";
import { $ } from "../ui/dom";
import { html, setHtml } from "../ui/html";
import { renderError } from "../ui/widgets";

/** The route's target from its hash parts (`#/web/post/<id>`, `#/web/template`), or null
 *  for one that names neither. */
export function webTarget(
  kind: string | undefined,
  id: string | undefined,
): WebPreviewTarget | null {
  if (kind === "template") {
    return "template";
  }
  return kind === "post" && id ? { post: decodeURIComponent(id) } : null;
}

export async function renderWebVersion(
  target: WebPreviewTarget,
  root: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  const isTemplate = target === "template";
  const back = isTemplate ? "#/template" : `#/edit/${encodeURIComponent(target.post)}`;
  const page = isTemplate
    ? "/api/settings/template/web"
    : `/api/posts/${encodeURIComponent(target.post)}/web`;
  setHtml(
    root,
    html`<div class="editor-head">
      <a href="${back}" class="back">${isTemplate ? "← Template" : "← Post"}</a>
      <span class="muted web-note">${isTemplate ? "The sample post as an archive page shows it" : "How the post's archive page will look once it's sent"}</span>
    </div>
    <div id="webBody"></div>`,
  );
  const body = $("#webBody", root);
  try {
    const doc = await apiText(page, { signal });
    // No script and no form, as the page itself forbids when served (SPEC §5); a link
    // may open in a new tab.
    setHtml(
      body,
      html`<iframe class="web-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Web version"></iframe>`,
    );
    const frame = $<HTMLIFrameElement>(".web-frame", body);
    frame.onload = () => {
      const h = frame.contentDocument?.documentElement?.scrollHeight;
      if (h) {
        frame.style.height = `${h}px`;
      }
    };
    frame.srcdoc = doc;
  } catch (e) {
    if (signal.aborted) {
      return;
    }
    renderError(body, e instanceof Error ? e.message : String(e), () =>
      mount((r, s) => renderWebVersion(target, r, s)),
    );
  }
}
