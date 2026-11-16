// The signature field of Settings › Accounts (ADR 0142, rule 1): one open at a time, its text kept
// across a refresh of the list, and a save that ends late closing only its own field.
import { describe, expect, it } from "vitest";
import {
  closeSignatureField,
  NO_PENDING_SIGNATURES,
  NO_SAVED_SIGNATURES,
  NO_SIGNATURE_FIELD,
  openSignatureField,
  recordSavedSignature,
  savedSignatureField,
  signatureAlert,
  signatureFieldText,
  signatureSaveEnded,
  signatureSaveStarted,
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
  describe("a save still on its way, when the field is opened again", () => {
    it("the reviewer's case: One is on its way, A's field is closed and opened again, Save of Old waits and then writes", () => {
      // A shows Old. One is saved; B's field is opened (A's closes); A's is opened again.
      let pending = signatureSaveStarted(NO_PENDING_SIGNATURES, "a", "One", 1);
      let fields = openSignatureField("a");
      fields = openSignatureField("b");
      fields = openSignatureField("a");
      // The new field starts with what is on its way, and is saving: Save is not unchanged.
      expect(signatureFieldText(fields.typed.a, pending, "a", "Old")).toBe("One");
      expect(signatureUnchanged(NO_SAVED_SIGNATURES, "a", "Old", "Old", pending)).toBe(false);
      expect(signatureUnchanged(NO_SAVED_SIGNATURES, "a", "Old", "One", pending)).toBe(false);
      // The person puts Old back while One goes; One ends: the field stays, with Old.
      fields = typeInSignatureField(fields, "a", "Old");
      pending = signatureSaveEnded(pending, "a", 1);
      const saved = recordSavedSignature(NO_SAVED_SIGNATURES, "a", "One", 1);
      fields = savedSignatureField(fields, "a", "One");
      expect(fields).toEqual({ open: "a", typed: { a: "Old" } });
      // Now Save of Old writes, whether or not the list caught up with One: the store ends on Old.
      expect(pending).toEqual(NO_PENDING_SIGNATURES);
      expect(signatureUnchanged(saved, "a", "Old", "Old", pending)).toBe(false);
      const caught = signaturesCaughtUp(saved, [{ id: "a", signature: "One" }]);
      expect(signatureUnchanged(caught, "a", "One", "Old", pending)).toBe(false);
    });

    it("a pending save that fails, then a later Save", () => {
      let pending = signatureSaveStarted(NO_PENDING_SIGNATURES, "a", "One", 1);
      expect(signatureUnchanged(NO_SAVED_SIGNATURES, "a", "Old", "Old", pending)).toBe(false);
      pending = signatureSaveEnded(pending, "a", 1);
      // Nothing was written: the store holds Old. Save of Old is unchanged and only closes; Save
      // of One sends it again.
      expect(signatureUnchanged(NO_SAVED_SIGNATURES, "a", "Old", "Old", pending)).toBe(true);
      expect(signatureUnchanged(NO_SAVED_SIGNATURES, "a", "Old", "One", pending)).toBe(false);
      // A field opened after the failure starts from the list again.
      expect(signatureFieldText(undefined, pending, "a", "Old")).toBe("Old");
    });

    it("two accounts pending at once: each its own", () => {
      let pending = signatureSaveStarted(NO_PENDING_SIGNATURES, "a", "Anna", 1);
      pending = signatureSaveStarted(pending, "b", "Ben", 2);
      expect(signatureFieldText(undefined, pending, "a", "")).toBe("Anna");
      expect(signatureFieldText(undefined, pending, "b", "")).toBe("Ben");
      pending = signatureSaveEnded(pending, "b", 2);
      expect(pending).toEqual({ a: { text: "Anna", order: 1 } });
      expect(signatureUnchanged(NO_SAVED_SIGNATURES, "a", "", "", pending)).toBe(false);
      expect(signatureUnchanged(NO_SAVED_SIGNATURES, "b", "", "", pending)).toBe(true);
      // An end that is not the account's save in flight changes nothing.
      expect(signatureSaveEnded(pending, "a", 7)).toBe(pending);
      expect(signatureSaveEnded(pending, "b", 2)).toBe(pending);
    });

    it("closed while pending (Escape) and opened again: still saving, typed text first", () => {
      const pending = signatureSaveStarted(NO_PENDING_SIGNATURES, "a", "One", 1);
      let fields = typeInSignatureField(openSignatureField("a"), "a", "One");
      fields = closeSignatureField(fields, "a");
      expect(fields).toEqual(NO_SIGNATURE_FIELD);
      // Closing a field never ends its save.
      expect(pending.a).toEqual({ text: "One", order: 1 });
      fields = openSignatureField("a");
      expect(signatureFieldText(fields.typed.a, pending, "a", "Old")).toBe("One");
      expect(signatureUnchanged(NO_SAVED_SIGNATURES, "a", "Old", "One", pending)).toBe(false);
      // A row made anew keeps what was typed in it.
      expect(signatureFieldText("Two", pending, "a", "Old")).toBe("Two");
    });
  });
});
