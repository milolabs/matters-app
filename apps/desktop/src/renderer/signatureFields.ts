/**
 * The signature field of Settings › Accounts (ADR 0142, rule 1): which account's is open, one at a
 * time, and what is typed in it. The text is kept here, not in the field: a refresh of the list
 * makes its rows anew, and the field must come back with what the person wrote. Pure.
 */
export interface SignatureFields {
  readonly open: string | null;
  readonly typed: Readonly<Record<string, string>>;
}

export const NO_SIGNATURE_FIELD: SignatureFields = { open: null, typed: {} };

/** The field of `id` opens, with what it holds; another one that was open closes. */
export function openSignatureField(id: string): SignatureFields {
  return { open: id, typed: {} };
}

/** What the person typed in the field of `id`, while it is open. */
export function typeInSignatureField(
  fields: SignatureFields,
  id: string,
  text: string,
): SignatureFields {
  return fields.open === id ? { ...fields, typed: { ...fields.typed, [id]: text } } : fields;
}

/**
 * The field of `id` closes: Cancel, Escape, or its save ended. Only that one: a save that ends
 * after another account's field was opened leaves that field and its text as they are.
 */
export function closeSignatureField(fields: SignatureFields, id: string): SignatureFields {
  if (fields.open !== id) return fields;
  return NO_SIGNATURE_FIELD;
}

/**
 * The save of `submitted` in the field of `id` ended. The field closes when it still holds what
 * was saved; text typed while the save was on its way is newer, so the field stays open with it
 * for the person to save too. Another account's field is left as it is.
 */
export function savedSignatureField(
  fields: SignatureFields,
  id: string,
  submitted: string,
): SignatureFields {
  if (fields.open !== id) return fields;
  const now = fields.typed[id];
  if (now !== undefined && now !== submitted) return fields;
  return NO_SIGNATURE_FIELD;
}

/** A save of the field that failed: why, and the text it tried to save. */
export interface SignatureFailure {
  readonly why: string;
  readonly text: string;
}

/**
 * The line under the field: what is wrong with the text, else why its last save failed, only
 * while the field still holds the text that failed. A change makes that reason stale: the person
 * may be fixing what it said.
 */
export function signatureAlert(
  problem: string | null,
  failure: SignatureFailure | null,
  text: string,
): string | null {
  if (problem !== null) return problem;
  return failure !== null && failure.text === text ? failure.why : null;
}

/**
 * What the last save of each account's signature that succeeded left in the store, as its answer
 * said, with the order that save was pressed in. The list of accounts is read again after a save,
 * but until it is, the account it shows still has the signature from before: the field compares
 * with this too, so a text that differs from what the store holds is never taken for unchanged.
 */
export type SavedSignatures = Readonly<
  Record<string, { readonly text: string; readonly order: number }>
>;

export const NO_SAVED_SIGNATURES: SavedSignatures = {};

/**
 * A save of `id`'s signature succeeded with `text`, its answer. It stands unless a save pressed
 * later already succeeded: the store applies the saves in the order they were asked for, so the
 * later one's text is what it holds, whichever answer came first.
 */
export function recordSavedSignature(
  saved: SavedSignatures,
  id: string,
  text: string,
  order: number,
): SavedSignatures {
  const had = saved[id];
  if (had !== undefined && had.order > order) return saved;
  return { ...saved, [id]: { text, order } };
}

/**
 * The list of accounts was read again: an account that now shows the text of its last save has
 * caught up, and the list is what the field compares with again. One that shows other text may
 * have been read before the save landed; its saved text stays.
 */
export function signaturesCaughtUp(
  saved: SavedSignatures,
  accounts: readonly { readonly id: string; readonly signature?: string | undefined }[],
): SavedSignatures {
  let out: Record<string, { readonly text: string; readonly order: number }> | null = null;
  for (const a of accounts) {
    const had = saved[a.id];
    if (had === undefined || had.text !== (a.signature ?? "")) continue;
    out ??= { ...saved };
    delete out[a.id];
  }
  return out ?? saved;
}

/**
 * Whether the field's text, as it would be kept, is what the store holds already, so Save only
 * closes the field. Only when it is the account's signature as the list shows it and the text of
 * the last save that succeeded, while one has not been caught up with: when the two differ, the
 * store may hold either, and a save of the same text again costs nothing.
 */
export function signatureUnchanged(
  saved: SavedSignatures,
  id: string,
  shown: string,
  kept: string,
): boolean {
  const had = saved[id];
  return kept === shown && (had === undefined || had.text === kept);
}
