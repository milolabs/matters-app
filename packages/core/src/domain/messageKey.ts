/** Sequence numbers per millisecond: keys of messages with equal dates stay distinct. */
export const MESSAGE_KEY_SEQ_LIMIT = 1024;

/**
 * Chronological message key (ADR 0006): `dateMs * 1024 + seq`.
 * Used as the SQLite rowid, so "newest N" is a reverse rowid scan.
 */
export function messageKey(dateMs: number, seq: number): number {
  if (!Number.isInteger(dateMs)) {
    throw new RangeError(`dateMs must be an integer, got ${dateMs}`);
  }
  if (!Number.isInteger(seq) || seq < 0 || seq >= MESSAGE_KEY_SEQ_LIMIT) {
    throw new RangeError(`seq must be an integer in [0, ${MESSAGE_KEY_SEQ_LIMIT}), got ${seq}`);
  }
  const key = dateMs * MESSAGE_KEY_SEQ_LIMIT + seq;
  if (!Number.isSafeInteger(key)) {
    throw new RangeError(`message key is not a safe integer for dateMs ${dateMs}`);
  }
  return key;
}

export function splitMessageKey(key: number): { dateMs: number; seq: number } {
  const dateMs = Math.floor(key / MESSAGE_KEY_SEQ_LIMIT);
  return { dateMs, seq: key - dateMs * MESSAGE_KEY_SEQ_LIMIT };
}
