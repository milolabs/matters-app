// The signature field of Settings › Accounts (ADR 0142, rule 1): one open at a time, its text kept
// across a refresh of the list, and a save that ends late closing only its own field.
import { describe, expect, it } from "vitest";
import {
  closeSignatureField,
  NO_SAVED_SIGNATURES,
  NO_SIGNATURE_FIELD,
  openSignatureField,
  recordSavedSignature,
  savedSignatureField,
  signatureAlert,
  signaturesCaughtUp,
  signatureUnchanged,
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

  it("says why a save failed only while the field holds the text that failed", () => {
    const failure = { why: "The signature was not saved.", text: "Anna" };
    expect(signatureAlert(null, failure, "Anna")).toBe("The signature was not saved.");
    // The person edits to fix it: the reason is stale and goes.
    expect(signatureAlert(null, failure, "Anna K")).toBeNull();
    // What is wrong with the text now comes first; with neither, nothing is said.
    expect(signatureAlert("Too long.", failure, "Anna")).toBe("Too long.");
    expect(signatureAlert(null, null, "Anna")).toBeNull();
  });

  describe("what Save takes for unchanged: what the store holds", () => {
    it("the reviewer's case: a save of One ended, the list still shows Old, the field holds Old", () => {
      // Old; One is saved; Old is put back while the save is on its way; the save ends.
      let fields = typeInSignatureField(openSignatureField("a"), "a", "One");
      fields = typeInSignatureField(fields, "a", "Old");
      fields = savedSignatureField(fields, "a", "One");
      expect(fields.open).toBe("a");
      const saved = recordSavedSignature(NO_SAVED_SIGNATURES, "a", "One", 1);
      // Before the list is read again, Save of Old saves it: the store holds One.
      expect(signatureUnchanged(saved, "a", "Old", "Old")).toBe(false);
      expect(signatureUnchanged(saved, "a", "Old", "One")).toBe(false);
      // The list caught up: it shows One, the saved text is let go, and One is unchanged.
      const caught = signaturesCaughtUp(saved, [{ id: "a", signature: "One" }]);
      expect(caught).toEqual(NO_SAVED_SIGNATURES);
      expect(signatureUnchanged(caught, "a", "One", "One")).toBe(true);
      expect(signatureUnchanged(caught, "a", "One", "Old")).toBe(false);
    });

    it("with no save of its own, the account as the list shows it is the baseline", () => {
      expect(signatureUnchanged(NO_SAVED_SIGNATURES, "a", "Old", "Old")).toBe(true);
      expect(signatureUnchanged(NO_SAVED_SIGNATURES, "a", "", "")).toBe(true);
      expect(signatureUnchanged(NO_SAVED_SIGNATURES, "a", "Old", "New")).toBe(false);
    });

    it("two saves on their way: the one pressed later is what the store holds, whichever ends first", () => {
      const later = recordSavedSignature(NO_SAVED_SIGNATURES, "a", "Two", 2);
      expect(recordSavedSignature(later, "a", "One", 1)).toBe(later);
      const inOrder = recordSavedSignature(
        recordSavedSignature(NO_SAVED_SIGNATURES, "a", "One", 1),
        "a",
        "Two",
        2,
      );
      expect(inOrder).toEqual(later);
      expect(signatureUnchanged(later, "a", "Old", "One")).toBe(false);
      // Another account's save is its own.
      const both = recordSavedSignature(later, "b", "Ben", 3);
      expect(both).toEqual({ a: { text: "Two", order: 2 }, b: { text: "Ben", order: 3 } });
    });

    it("a list read before the save landed does not let the saved text go", () => {
      const saved = recordSavedSignature(NO_SAVED_SIGNATURES, "a", "One", 1);
      // Read before the write, or changed elsewhere since: either way not caught up.
      expect(signaturesCaughtUp(saved, [{ id: "a", signature: "Old" }])).toBe(saved);
      expect(signaturesCaughtUp(saved, [{ id: "b", signature: "One" }])).toBe(saved);
      // The list shows Zed (from elsewhere, or not yet One): Save of One saves it again, and so
      // does a Save of Zed; neither is taken for unchanged while the two disagree.
      expect(signatureUnchanged(saved, "a", "Zed", "One")).toBe(false);
      expect(signatureUnchanged(saved, "a", "Zed", "Zed")).toBe(false);
      // A signature saved as none caught up when the list shows none.
      const none = recordSavedSignature(NO_SAVED_SIGNATURES, "a", "", 1);
      expect(signaturesCaughtUp(none, [{ id: "a" }])).toEqual(NO_SAVED_SIGNATURES);
    });
  });
});
