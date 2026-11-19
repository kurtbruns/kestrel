// Which modifier key an app shortcut takes on this device: ⌘ on Apple's, Ctrl everywhere else.
// On a Mac, Ctrl is the text field's own: Ctrl+A and Ctrl+E go to a line's ends, Ctrl+B and
// Ctrl+F move a character, Ctrl+K deletes to the line's end and Ctrl+Y puts it back. Taking
// Ctrl as well as ⌘ for a shortcut would take those keys away from people who type with them.

/** Whether this is an Apple device, where app shortcuts take ⌘. iPadOS reports a Mac. */
export function onApple(platform: string = navigator.platform): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

/** Whether the event holds this device's shortcut modifier: ⌘ on Apple's, Ctrl elsewhere. */
export function shortcutKey(e: KeyboardEvent, apple: boolean = onApple()): boolean {
  return apple ? e.metaKey : e.ctrlKey;
}

/**
 * The letter a shortcut was pressed on, lower case: the key's own when it is a Latin letter,
 * else the letter at that place on a US keyboard. Off a Mac, Ctrl+B on a Cyrillic or Greek
 * layout reports the layout's letter ("и"), which no shortcut names, so the key's place
 * stands in for it, as desktop apps do. A Latin layout's own letter wins, so Ctrl+B is B on
 * AZERTY and Dvorak wherever B sits.
 */
export function shortcutLetter(e: KeyboardEvent): string {
  const key = e.key.toLowerCase();
  if (/^[a-z]$/.test(key)) {
    return key;
  }
  const place = /^Key([A-Z])$/.exec(e.code);
  return place ? (place[1] ?? "").toLowerCase() : key;
}

/** How a shortcut is written on this device: "⌘K" on Apple's, "Ctrl+K" elsewhere. */
export function shortcutLabel(key: string, apple: boolean = onApple()): string {
  return apple ? `⌘${key}` : `Ctrl+${key}`;
}

/** Ctrl keys that change a Mac text field's text: delete back (H) or forward (D), delete to
 *  the line's end (K), open a line (O), swap two characters (T), and put back what K took (Y). */
const APPLE_CTRL_EDITS = ["h", "d", "k", "o", "t", "y"];

/** Whether a key held with a modifier would change a text field's text: cut, undo, or redo
 *  with the shortcut key, or one of a Mac's own Ctrl edits. Paste fires its own event. */
export function modifiedKeyEdits(e: KeyboardEvent, apple: boolean = onApple()): boolean {
  const k = shortcutLetter(e);
  if (shortcutKey(e, apple)) {
    return ["x", "z", "y"].includes(k);
  }
  return apple && e.ctrlKey && APPLE_CTRL_EDITS.includes(k);
}
