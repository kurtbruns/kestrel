// The editor's saves still in flight, for a view the editor hands over to in the same
// document. The web version link opens in place in a browser pane with no tabs, and its
// read of the post must not overtake the save carrying the publisher's last edits.

let pending: Promise<unknown> = Promise.resolve();

/** Record the editor's save chain as it stands; it settles once every save queued so far has. */
export function trackSaves(chain: Promise<unknown>): void {
  pending = chain;
}

/** Settles, never rejects, once every save the editor has queued has landed or failed. A
 *  failed save shows in the editor; the reader here only waits its turn. */
export function savesSettled(): Promise<void> {
  return pending.then(
    () => {},
    () => {},
  );
}
