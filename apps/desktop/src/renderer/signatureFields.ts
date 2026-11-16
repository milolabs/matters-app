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
