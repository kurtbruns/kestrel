// Where a caret or selection goes when the text under it is replaced wholesale, as when
// another writer's version is taken into the editor: an offset before the change keeps its
// place, one after it moves with the text that follows, and one inside it lands at the
// change's end, so the caret stays near what the publisher was reading.

/** `offset` in `before`, carried to the same place in `after`. */
export function carryOffset(before: string, after: string, offset: number): number {
  const most = Math.min(before.length, after.length);
  let head = 0;
  while (head < most && before[head] === after[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < most - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  // Never split a character written as two UTF-16 units (an emoji, say): a head that ends on
  // the first of a pair, or a tail that starts on the second, gives that unit back to the change.
  if (head > 0 && isHigh(before.charCodeAt(head - 1))) {
    head--;
  }
  if (tail > 0 && isLow(before.charCodeAt(before.length - tail))) {
    tail--;
  }
  if (offset <= head) {
    return Math.min(offset, after.length);
  }
  if (offset >= before.length - tail) {
    return Math.max(0, Math.min(after.length, offset + after.length - before.length));
  }
  return after.length - tail;
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
