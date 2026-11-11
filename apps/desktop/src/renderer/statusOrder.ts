// Answers about the agent's status can come back in another order than they were asked. An old
// one must not undo what the person just chose, so an answer only counts if nothing asked later
// has already been shown.

export interface StatusOrder {
  /** Calls `apply` with the answer, unless an answer to something asked later already came. */
  settle<T>(work: Promise<T>, apply: (value: T) => void): Promise<T>;
}

export function createStatusOrder(): StatusOrder {
  let asked = 0;
  let shown = 0;
  return {
    async settle(work, apply) {
      const mine = ++asked;
      const value = await work;
      if (mine > shown) {
        shown = mine;
        apply(value);
      }
      return value;
    },
  };
}
