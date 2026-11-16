// Whether the editor's fields differ from what was last saved, as one comparison of a
// snapshot: the fields serialized. "Dirty" drives the save-status cue, the navigation
// guards, and whether an autosave has anything to do.

export class DirtyTracker<T> {
  /** The snapshot the server holds, or null when it holds none of what is on screen. */
  #saved: string | null;

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

  /**
   * Nothing on screen is saved, whatever it matches. The publisher chose Keep editing over
   * another writer's newer version (SPEC §4) after undoing back to our last save: the server
   * holds theirs, so these fields are owed a save even though they match ours, and stay so
   * until one lands.
   */
  markUnsaved(): void {
    this.#saved = null;
  }
}
