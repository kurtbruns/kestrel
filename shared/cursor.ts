/**
 * The send cursor (SPEC §8): where a read of sends stood, handed to a client so it can
 * later ask for what changed since.
 *
 * It carries two positions. `seq` is the change sequence at the read: a send whose visible
 * state changed afterward has a higher `rev`. `at` is the server's time of the read, for
 * what changes with the clock rather than with a write (a fire time passing, a send
 * becoming stuck, a lease running out), which no `rev` can record.
 *
 * The format is part of the API, not a private detail: `<seq>.<at>`, both decimal
 * integers. Any client may read it and compare two, so a client following sends from
 * several reads (a list, and one send's page) can follow them all from the earlier cursor
 * in one feed read, as the editor does; nothing here is the editor's alone. A cursor that
 * does not parse is refused, never guessed at.
 */

/** A read's position among the changes to sends. */
export interface SendCursor {
  seq: number;
  at: number;
}

const PATTERN = /^(\d+)\.(\d+)$/;

/** The cursor as the API carries it. */
export function encodeSendCursor(cursor: SendCursor): string {
  return `${cursor.seq}.${cursor.at}`;
}

/** A cursor a client handed back, or null when it is not one this server issued. */
export function decodeSendCursor(raw: string): SendCursor | null {
  const match = PATTERN.exec(raw);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const seq = Number(match[1]);
  const at = Number(match[2]);
  return Number.isSafeInteger(seq) && Number.isSafeInteger(at) ? { seq, at } : null;
}

/**
 * A cursor at or before both (the smaller `seq` and the smaller `at`): asking what changed
 * since it answers for each of them, and a send reported twice reads the same both times.
 * The rule any client may apply to the documented format; one that does not parse gives way
 * to the other.
 */
export function earlierCursor(a: string, b: string): string {
  const x = decodeSendCursor(a);
  const y = decodeSendCursor(b);
  if (!x || !y) {
    return x ? a : b;
  }
  return encodeSendCursor({ seq: Math.min(x.seq, y.seq), at: Math.min(x.at, y.at) });
}
