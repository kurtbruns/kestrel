/**
 * The send cursor (SPEC §8): where a read of sends stood, handed to a client so it can
 * later ask for what changed since.
 *
 * It carries two positions. `seq` is the change sequence at the read: a send whose visible
 * state changed afterward has a higher `rev`. `at` is the server's time of the read, for
 * what changes with the clock rather than with a write (a fire time passing, a send
 * becoming stuck, a lease running out), which no `rev` can record. The string is opaque to
 * clients, so its format is free to change; a cursor that does not parse is refused, never
 * guessed at.
 */

/** A read's position among the changes to sends. */
export interface SendCursor {
  seq: number;
  at: number;
}

const PATTERN = /^([0-9a-z]+)\.([0-9a-z]+)$/;

/** The cursor as the API carries it. */
export function encodeSendCursor(cursor: SendCursor): string {
  return `${cursor.seq.toString(36)}.${cursor.at.toString(36)}`;
}

/** A cursor a client handed back, or null when it is not one this server issued. */
export function decodeSendCursor(raw: string): SendCursor | null {
  const match = PATTERN.exec(raw);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const seq = Number.parseInt(match[1], 36);
  const at = Number.parseInt(match[2], 36);
  return Number.isSafeInteger(seq) && Number.isSafeInteger(at) ? { seq, at } : null;
}
