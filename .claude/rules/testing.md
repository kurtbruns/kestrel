---
paths:
  - "test/**"
  - "client/**/*.spec.ts"
  - "client/test/**"
  - "shared/**/*.spec.ts"
  - "vitest.config.ts"
---

# Writing tests

A test is evidence that the app does what `docs/SPEC.md` says. Keep each one plain: set up what it needs, do one thing, assert exactly what should be true.

## Where a test goes

- Four Vitest projects, one per runtime (`vitest.config.ts` says why): `worker` (`test/*.spec.ts`, inside workerd with real D1 and R2), `client` (`client/**/*.spec.ts`, beside its module, under happy-dom), `shared` (`shared/**/*.spec.ts`, plain Node), and `cli` (`test/cli/`).
- A change to behavior comes with a test in the project of the code that changed, in the spec named for that module or behavior.
- A title states the behavior, not the mechanism, and cites the SPEC section or invariant it is evidence for when there is one.
- Test what the API does through `SELF.fetch` (the real router, auth, and error shaping); call a module directly to test its own logic.

## Each test stands alone

- A Worker spec that writes to D1 starts each test from `resetDatabase()`; a client spec from `resetShell()`. `resetDatabase()` empties D1 only: module state a spec uses (the fake outbox, notifications, a key cache, R2 objects) is cleared in its own `beforeEach`.
- It passes in any order and on any date. Check with `npx vitest run --sequence.shuffle.tests`. Build times from `Date.now()`, never a fixed epoch in the future. To move time, fake `Date` (`vi.useFakeTimers({ toFake: ["Date"] })`) and set it (`vi.setSystemTime`) rather than sleeping; `tick()` does this, so a spec that uses it fakes `Date` in `beforeEach`.
- To test what happens between two steps (a race, an unsubscribe mid-send), run the first step directly, change the state, then run the second. Spy on an internal only when there is no other way in.
- Cleanup goes in `afterEach` (`vi.restoreAllMocks()`, `vi.unstubAllGlobals()`, `vi.useRealTimers()`), so it runs when an assertion fails too.

## Use the shared helpers

- Worker: `test/support/fixtures.ts` (`resetDatabase`, `seedConfirmed`, `frozenSend`, `dueSend`, `tick`, `seedDelivery`), `test/support/http.ts` (`base`, `AUTH`, `JSON_AUTH`, `readJson`, `adminAuth` for another principal), and `test/support/worker_env.ts` (`withVars`, `fetchWith`) to run the Worker under other deploy settings. The other `test/support/` modules each say in their header what they are for.
- Client: `client/test/support.ts` (`fakeApi`, `settle`, `resetShell`, `sendSummary`, `settingsResponse`, `stubClipboard`) and `client/test/send_server.ts` (the fake send feed: `sendServer`, `feedReads`, `listReads`). How a view test uses them is below.
- Add a helper there when a second spec needs it. A fixture that really differs stays in its spec, named for what it does differently.

## Client view tests

- `client/test/setup.ts` puts the real admin shell (`public/dashboard/index.html`) in the document before a spec's imports, because the shell reads its roots at import time. happy-dom's file loading is off so an inserted `<link>` is never fetched.
- A view test runs the real view over `fakeApi(routes)`, which replaces the global `fetch`, so `api()` itself runs. Mount the view as the router does (`mount(renderDrafts)`), `settle()`, query the DOM, act, assert, and assert `fake.unhandled` is empty; `unmount()` is navigating away. `posts/drafts.spec.ts` is the pattern.
- `settle()` waits on a real timer: under `vi.useFakeTimers()` use `vi.advanceTimersByTimeAsync(0)` instead.
- A client spec never reaches the Worker, and `client/test/` never enters the bundle.

## A test must be able to fail

- Assert the exact value (`toBe`, `toEqual`), not `toBeTruthy()` or a range, unless the range is the behavior.
- Before relying on a new test, break the code it guards and watch it fail.
- A known bug that isn't fixed yet is pinned with `it.fails(...)` and a one-line comment naming the bug; the fix turns it into `it`.

## Logs and output

- A Worker test that causes an error-level log line on purpose allows it, at the start of the test: `allowErrorLogs("send.wedged")` (`test/support/log.ts`). Any other error line fails the test. Allowing doesn't assert; to prove a failure was logged, read the line back with `logged()`.
- A passing test's console output isn't printed (`--silent=false` shows it), so don't mock the console to keep a spec quiet. Spy on it only to assert on a line.
