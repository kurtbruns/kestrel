// Dev-only live reload for the admin SPA: notice a rebuilt bundle or an edited stylesheet
// and pick it up without a hand refresh.
//
// The signal is the served index.html's own `?v=` stamps: scripts/build-client.mjs
// regenerates it with each asset's content hash after every rebuild, and this polls it
// once a second and compares the stamps to the ones the page loaded with. Nothing is
// pushed: polling what the browser would load is the one check that can never disagree
// with it. A new app.js stamp means the page itself is stale, so it reloads; a new
// styles.css stamp is hot-swapped in place, so the common CSS tweak loop never loses
// editor state. Only the dev flavor contains this (`__DEV__`, see the build script).

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
 * Swap the stylesheet to its new stamp without a flash: insert the new `<link>` after the
 * last one for this stylesheet, and drop every older one only once the new has loaded (or
 * failed — a broken stylesheet must not leave two stacked). "Last" and "every" matter: two
 * swaps in quick succession, the second before the first has loaded, must still end with
 * the newest stylesheet last in the cascade and alone. Returns false when there is no
 * stylesheet link to swap.
 */
export function swapStylesheet(doc: Document, stamp: string): boolean {
  const older: HTMLLinkElement[] = [];
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) {
    const href = link.getAttribute("href");
    if (href && new URL(href, "http://stamps.invalid/dashboard/").pathname.endsWith(`/${CSS}`)) {
      older.push(link);
    }
  }
  const last = older.at(-1);
  if (!last) {
    return false;
  }
  const fresh = doc.createElement("link");
  fresh.rel = "stylesheet";
  fresh.href = `./${CSS}?v=${encodeURIComponent(stamp)}`;
  const retire = () => {
    for (const link of older) {
      link.remove();
    }
  };
  fresh.addEventListener("load", retire, { once: true });
  fresh.addEventListener("error", retire, { once: true });
  last.after(fresh);
  return true;
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
 * matters because `wrangler dev` keeps serving a rewritten file (index.html is regenerated
 * in place) under its original ETag: a plain `location.reload()` revalidates, gets a 304,
 * and would reuse the stale cached page — and then poll, see the new stamp, and reload
 * again, forever. With the entry refreshed by every poll, the 304 hands the reload the
 * current page. The stamped assets themselves are new URLs, so they never hit this.
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
 * boot probe has reported auth mode `dev`; the poll itself never re-checks that. A reload
 * is requested once, then the poll stops: the editor's leave guard can turn the reload
 * into a prompt, and a declined prompt must not come back every second — the page is
 * stale by choice at that point, and a hand refresh ends it.
 */
export function startDevReload(opts: DevReloadOptions = {}): () => void {
  const doc = opts.doc ?? document;
  const fetchIndex = opts.fetchIndex ?? fetchLiveIndex;
  const reload = opts.reload ?? (() => location.reload());
  const loaded = readStamps(doc);
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => clearInterval(timer);

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
        stop();
        reload();
      } else if (plan === "swap-css" && current.css && swapStylesheet(doc, current.css)) {
        loaded.css = current.css;
      }
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(tick, opts.intervalMs ?? 1000);
  return stop;
}
