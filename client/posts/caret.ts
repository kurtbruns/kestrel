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
  if (offset <= head) {
    return Math.min(offset, after.length);
  }
  if (offset >= before.length - tail) {
    return Math.max(0, Math.min(after.length, offset + after.length - before.length));
  }
  return after.length - tail;
}
