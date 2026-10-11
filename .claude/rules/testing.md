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

## Each test stands alone

- A Worker test starts from `resetDatabase()`; a client test from `resetShell()`. Nothing carries over from the test before it.
- It passes in any order and on any date. Check with `npx vitest run --sequence.shuffle.tests`. Build times from `Date.now()`, never a fixed epoch in the future, and to move time, fake `Date` (`vi.useFakeTimers({ toFake: ["Date"] })`) and set it (`vi.setSystemTime`) rather than sleeping.
- Cleanup goes in `afterEach` (`vi.restoreAllMocks()`, `vi.unstubAllGlobals()`, `vi.useRealTimers()`), so it runs when an assertion fails too.

## Use the shared helpers

- Worker: `test/support/fixtures.ts` (`resetDatabase`, `seedConfirmed`, `frozenSend`, `dueSend`, `tick`) and `test/support/http.ts` (`base`, `AUTH`, `JSON_AUTH`, `readJson`). The other `test/support/` modules each say in their header what they are for.
- Client: `client/test/support.ts`, and the view-test pattern in `.claude/rules/client.md`.
- Add a helper there when a second spec needs it. A fixture that really differs stays in its spec, named for what it does differently.

## A test must be able to fail

- Assert the exact value (`toBe`, `toEqual`), not `toBeTruthy()` or a range, unless the range is the behavior.
- Before relying on a new test, break the code it guards and watch it fail.
- A known bug that isn't fixed yet is pinned with `it.fails(...)` and a one-line comment naming the bug; the fix turns it into `it`.

## Logs and output

- A Worker test that causes an error-level log line declares it: `expectErrorLogs("send.wedged")` (`test/support/log.ts`). An undeclared one fails the test, and so does a declared one that never appears.
- A passing test's console output isn't printed, so don't mock the console to keep a spec quiet. Spy on it only to assert on a line.
