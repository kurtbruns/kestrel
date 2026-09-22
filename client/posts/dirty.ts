// Whether the editor's fields differ from what was last saved, as one comparison of a
// snapshot: the fields serialized. "Dirty" drives the save-status cue, the navigation
// guards, and whether an autosave has anything to do.

export class DirtyTracker<T> {
  #saved: string;

  constructor(private readonly read: () => T) {
    this.#saved = JSON.stringify(read());
  }

  /** The current values, in the form they are compared and sent. */
  snapshot(): string {
    return JSON.stringify(this.read());
  }

  get dirty(): boolean {
    return this.snapshot() !== this.#saved;
  }

  /**
   * What is saved now. Pass the snapshot that was actually sent: a save takes time, and an
   * edit typed while it was in flight is not saved by it. Marking the fields as they are
   * when the save lands would show that edit as saved and let a leave flush skip it.
   */
  markSaved(sent: string = this.snapshot()): void {
    this.#saved = sent;
  }
}
