// The signature field of Settings › Accounts (ADR 0142, rule 1): one open at a time, its text kept
// across a refresh of the list, and a save that ends late closing only its own field.
import { describe, expect, it } from "vitest";
import {
  closeSignatureField,
  NO_SIGNATURE_FIELD,
  openSignatureField,
  savedSignatureField,
  typeInSignatureField,
} from "../src/renderer/signatureFields.ts";

describe("the signature fields", () => {
  it("keeps what is typed in the open field, and only there", () => {
    let f = openSignatureField("a");
    f = typeInSignatureField(f, "a", "Anna");
    f = typeInSignatureField(f, "b", "not open");
    expect(f).toEqual({ open: "a", typed: { a: "Anna" } });
  });

  it("a save of one account that ends after another's field was opened leaves that field and its text", () => {
    // A's save is under way; B's field is opened and typed in; then A's save ends.
    let f = openSignatureField("a");
    f = openSignatureField("b");
    f = typeInSignatureField(f, "b", "Ben, unsaved");
    f = closeSignatureField(f, "a");
    expect(f).toEqual({ open: "b", typed: { b: "Ben, unsaved" } });
    // Its own close ends it, text and all.
    expect(closeSignatureField(f, "b")).toEqual(NO_SIGNATURE_FIELD);
  });

  it("a save that ends closes the field only while it holds what was saved", () => {
    // "One" is saved; "Two" is typed while that save is on its way: the field stays, with "Two".
    let f = openSignatureField("a");
    f = typeInSignatureField(f, "a", "One");
    f = typeInSignatureField(f, "a", "Two");
    expect(savedSignatureField(f, "a", "One")).toEqual({ open: "a", typed: { a: "Two" } });
    // Saved as it stands, or opened and saved with nothing typed, it closes.
    expect(savedSignatureField(f, "a", "Two")).toEqual(NO_SIGNATURE_FIELD);
    expect(savedSignatureField(openSignatureField("a"), "a", "One")).toEqual(NO_SIGNATURE_FIELD);
    // Another account's open field is left as it is.
    const b = typeInSignatureField(openSignatureField("b"), "b", "Ben");
    expect(savedSignatureField(b, "a", "One")).toBe(b);
  });
});
