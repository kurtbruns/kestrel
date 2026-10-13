---
paths:
  - "client/**"
---

# Working on the admin SPA

Framework-free, strict TypeScript in `client/`. The build is `.claude/rules/client-build.md`, specs are `.claude/rules/testing.md`, and what each screen shows is `docs/DESIGN.md`.

## Layout and imports

- Feature folders (`posts/`, `sends/`, `settings/`, …) hold their views, dialogs, and pure logic; flat in `client/` is the app itself (`main`, `router`, `lifecycle`, `state`, `api`, …) and the reads every feature shares, such as `send_state`. Names inside a folder drop the folder's word (`sends/list.ts`), except a namesake view (`dashboard/dashboard.ts`).
- `ui/` knows no feature or route: a `ui/` module imports only `ui/`, `shared/`, and the shell's roots. A widget that lives for a mount takes the mount's `AbortSignal` rather than importing `lifecycle`.
- Imports run one way, with no cycle: a flat module never imports a feature except `main.ts` (installs) and `router.ts` (mounts), and one feature imports another only through its exported shared pieces. A cycle breaks once a top-level statement reads across it, because esbuild hoists module scopes into one and that read sees `undefined`.
- Code the Worker also needs comes from `shared/`, never `src/`; move a Worker function there rather than mirror it.
- No module does anything at load but define things. A long-lived listener is registered by an `install…()` that `boot()` (`main.ts`) calls by name; one a single view owns registers on its first render. The shell's root lookups are the one load-time read. Check: `grep -rn addEventListener client --include='*.ts'` finds none at module scope.
- A module's header names one responsibility; one that needs "and" twice is two modules. `ui/widgets` and `ui/format` are catalogs of small pieces, not a home for a subsystem.
- Nothing carries `// @ts-nocheck`; `client/tsconfig.json` (DOM lib, no Worker or Vitest types) is typechecked as a second program.

## State and the view lifecycle

- App-wide state (token, session, settings payload) lives in `appState` (`state.ts`); everything else lives in the view that owns it. Never export a mutable `let`: ES modules cannot assign another module's binding.
- A view is `(root, signal) => handle?` (`lifecycle.ts`). It paints into `root`, never `#app`, and re-enters itself (a reload, a retry) through `mount()`, never by calling its render function.
- Bind what a view starts to its signal so nothing outlives it: `every()` for a ticker, `poll()` for a repeating read, the signal for a borrowed control, `modal`, or `openMenu`, and `{ signal }` on an `api()` read that paints.
- A write never takes the signal: a save the reader started must land whether or not they stayed.
- After an `await`, `if (signal.aborted) return;` before a `location.hash =`: a paint into a stale root is harmless, a redirect is not.
- A view offers the app only the `ViewHandle` it returns (`dirty()`, `beforeLeave()`, `manualSave()`).

## Following sends

- A page follows sends through `send_state` (`followSends` from its list read, which for Drafts is `GET /api/posts`, carrying the same cursor; `followSend` from its send read), never a poll of its own; the pace is the server's. After acting, it calls `readSendsNow()`.
- A follower's `stale()` means the server answered `cursor_ahead` (database reset or restored): the page re-reads its own list or send and follows again from that read.
- Every send a page holds is one `SendView` (`shared/sends.ts`), so a feed report replaces a row as is. Read the frozen email at `links.email_html`; it is never carried on a send.
- What is wrong with a send and what can be done to it are the server's: read its `conditions` and `actions` (`sends/progress.ts`), never derive a condition, threshold, or whether a control would work. The one clock rule a page applies is hiding a scheduled send's window controls at its fire time.

## Saving in the editor

- A change to how the editor saves starts in its pure, specced modules (`posts/autosave.ts`, `dirty.ts`, `revisions.ts`), under test, not in the view.

## Markup

- Build markup with the `html` tag (`client/ui/html.ts`). Every interpolation is escaped unless it is already `Html`; arrays flatten; `null`, `undefined`, and `false` render nothing; `true` is a compile error.
- Escaping makes two contexts safe: text, and a quoted attribute value whose meaning is text. An interpolation in an unquoted attribute value throws.
- Escaping does nothing for a value that is code or a URL. Not `href`, `src`, `action`, `formaction` (a `javascript:` URL has no character to escape; check the scheme before interpolating one from publisher or subscriber data), not `srcdoc`, `style`, or an `on*` handler, and never inside `<script>` or `<style>`, an attribute name, or a tag name.
- A function that returns markup returns `Html`, never `string`, so it composes without double escaping and the checker rejects a plain string where markup is expected. `Html` is nominal: a look-alike object is rejected at compile time and at runtime.
- Markup reaches the document through `setHtml(el, markup)`, the one place strings meet `innerHTML`. It throws on anything that is not `Html`.
- `unsafeHtml(s)` is the only way in for markup the tag did not build: server-rendered HTML from the API (the docs), or markup a module builds by string (the highlighters, the sample-email preview, which escape first and decorate after). Grep for it when auditing.
- A bare attribute (`disabled`, `hidden`, `readonly`) is markup, not text: spell it once as `html\` disabled\`` and interpolate that, never a string.
- Never interpolate an `escapeHtml()` result into `html`: it is escaped twice. `escapeHtml` is for text that will land in a page the tag does not build (the embed snippet a publisher pastes into their own site).

## Icons

- An icon is a complete SVG file in `client/ui/icons/` (`xmlns`, its own `viewBox`, `aria-hidden="true"`, `currentColor` to follow the text). Add one with the file, its entry in `ui/icons.ts`, and its line in `ui/icons.spec.ts`.
- A generated image (the letter avatar) is code, not an icon. How icons are inlined, and the sidebar sprite's exception, are in `client-build.md`.
