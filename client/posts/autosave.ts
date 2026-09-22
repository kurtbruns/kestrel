// Autosave timing, apart from the editor that uses it: save after a quiet pause, but never
// let an edit sit unsaved longer than a hard cap even while the typing never pauses. The
// idle timer restarts on every edit; the cap timer starts on the first edit after a save
// and is left alone until a save fires or cancels it. Manual Save stays the primary path;
// this is the safety net.

export interface AutosaveTimers {
  /** Quiet pause before a background save. */
  idleMs: number;
  /** Hard cap: no edit stays unsaved longer than this. */
  maxMs: number;
}

export const AUTOSAVE_TIMERS: AutosaveTimers = { idleMs: 5000, maxMs: 30000 };

export interface Autosave {
  /** An edit happened. */
  touch(): void;
  /** Forget the pending save: a save is starting, a conflict paused autosave, or the editor is leaving. */
  cancel(): void;
  /** Whether a save is scheduled. */
  readonly pending: boolean;
}

/** The two-timer machine; `save` runs once when either timer fires, with both cleared first. */
export function createAutosave(
  save: () => void,
  timers: AutosaveTimers = AUTOSAVE_TIMERS,
): Autosave {
  let idle: number | null = null;
  let cap: number | null = null;
  const cancel = () => {
    if (idle !== null) {
      clearTimeout(idle);
    }
    if (cap !== null) {
      clearTimeout(cap);
    }
    idle = null;
    cap = null;
  };
  const fire = () => {
    cancel();
    save();
  };
  return {
    touch() {
      if (idle !== null) {
        clearTimeout(idle);
      }
      idle = setTimeout(fire, timers.idleMs);
      if (cap === null) {
        cap = setTimeout(fire, timers.maxMs);
      }
    },
    cancel,
    get pending() {
      return idle !== null || cap !== null;
    },
  };
}
