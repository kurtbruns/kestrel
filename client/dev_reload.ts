// Dev-only live reload for the admin SPA: notice a rebuilt bundle or an edited stylesheet
// and pick it up without a hand refresh.
//
// The signal is index.html's own `?v=` stamps (scripts/stamp-admin-assets.mjs rewrites
// them after every rebuild), polled once a second. Nothing is pushed and nothing is
// compiled in: the bundle is byte-identical in dev and production — it must be, because
// the committed stamp IS a hash of it — and only a runtime check (the boot probe's auth
// mode is `dev`, which no deployed env has) turns this on. Polling the stamps also
// checks exactly the URLs the browser would load: a new app.js stamp means the page
// itself is stale, so it reloads; a new styles.css stamp is hot-swapped in place, so
// the common CSS tweak loop never loses editor state.

/** The `?v=` stamp on each fingerprinted asset reference in index.html, `null` if absent. */
export interface AssetStamps {
  app: string | null;
  css: string | null;
}

/** What a poll decided: the page is current, the stylesheet changed, or the bundle changed. */
export type ReloadPlan = "none" | "swap-css" | "reload";

const APP = "app.js";
const CSS = "styles.css";

/** The `?v=` of the first `<script>` / `<link rel=stylesheet>` whose URL path ends in `name`. */
function stampOf(doc: Document, selector: string, attr: string, name: string): string | null {
  for (const el of doc.querySelectorAll(selector)) {
    const raw = el.getAttribute(attr);
    if (!raw) {
      continue;
    }
    const url = new URL(raw, "http://stamps.invalid/dashboard/");
    if (url.pathname.endsWith(`/${name}`)) {
      return url.searchParams.get("v");
    }
  }
  return null;
}

/** Read the two asset stamps off a document: the live one, or a freshly fetched index.html. */
export function readStamps(doc: Document): AssetStamps {
  return {
    app: stampOf(doc, "script[src]", "src", APP),
    css: stampOf(doc, 'link[rel="stylesheet"][href]', "href", CSS),
  };
}

/** Parse a fetched index.html so readStamps can read it like the live document. */
export function parseIndex(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * Compare what the page loaded with against what index.html says now. A missing stamp on
 * either side is treated as "unchanged": the poll must never reload on a malformed or
 * partial index.html (mid-rewrite) — the next tick sees the finished file.
 */
export function planReload(loaded: AssetStamps, current: AssetStamps): ReloadPlan {
  if (loaded.app && current.app && loaded.app !== current.app) {
    return "reload";
  }
  if (loaded.css && current.css && loaded.css !== current.css) {
    return "swap-css";
  }
  return "none";
}

/**
 * Swap the stylesheet to its new stamp without a flash: insert the new `<link>` beside the
 * old one, and drop the old only once the new has loaded (or failed — a broken stylesheet
 * must not leave two stacked). Returns false when there is no stylesheet link to swap.
 */
export function swapStylesheet(doc: Document, stamp: string): boolean {
  for (const old of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) {
    const href = old.getAttribute("href");
    if (!href) {
      continue;
    }
    const url = new URL(href, "http://stamps.invalid/dashboard/");
    if (!url.pathname.endsWith(`/${CSS}`)) {
      continue;
    }
    const fresh = doc.createElement("link");
    fresh.rel = "stylesheet";
    fresh.href = `./${CSS}?v=${encodeURIComponent(stamp)}`;
    const retire = () => old.remove();
    fresh.addEventListener("load", retire, { once: true });
    fresh.addEventListener("error", retire, { once: true });
    old.after(fresh);
    return true;
  }
  return false;
}

/** The seams a poll runs through — real in the browser, substituted in the client tests. */
export interface DevReloadOptions {
  doc?: Document;
  fetchIndex?: () => Promise<string | null>;
  reload?: () => void;
  intervalMs?: number;
}

/**
 * Fetch the live index.html from the network; `null` on any failure (a server mid-restart,
 * say). Cache mode `reload`, not `no-store`: it bypasses the browser cache on the way out
 * but stores the response, so the cache entry for this page is the file as it is now. That
 * matters because `wrangler dev` keeps serving a rewritten asset under its original ETag:
 * a plain `location.reload()` revalidates, gets a 304, and would reuse the stale cached
 * page — and then poll, see the new stamp, and reload again, forever. With the entry
 * refreshed by every poll, the 304 hands the reload the current page.
 */
async function fetchLiveIndex(): Promise<string | null> {
  try {
    const res = await fetch(location.href, { cache: "reload" });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * Start polling index.html for a new stamp. Returns the stop function. Call only once the
 * boot probe has reported auth mode `dev`; the poll itself never re-checks that.
 */
export function startDevReload(opts: DevReloadOptions = {}): () => void {
  const doc = opts.doc ?? document;
  const fetchIndex = opts.fetchIndex ?? fetchLiveIndex;
  const reload = opts.reload ?? (() => location.reload());
  const loaded = readStamps(doc);
  let inFlight = false;

  const tick = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const html = await fetchIndex();
      if (html === null) {
        return;
      }
      const current = readStamps(parseIndex(html));
      const plan = planReload(loaded, current);
      if (plan === "reload") {
        reload();
      } else if (plan === "swap-css" && current.css && swapStylesheet(doc, current.css)) {
        loaded.css = current.css;
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(tick, opts.intervalMs ?? 1000);
  return () => clearInterval(timer);
}
