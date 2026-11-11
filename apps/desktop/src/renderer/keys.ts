/** What the window's single-key shortcuts need to know about the key press. */
export interface KeyPress {
  readonly key: string;
  readonly isComposing: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

/** Where the press landed. */
export interface KeyPlace {
  /** The composer is open: it has keys of its own. */
  readonly composeOpen: boolean;
  /** The query field has the focus. */
  readonly inSearch: boolean;
  /** Any text field, including the editor in its shadow root. */
  readonly textTarget: boolean;
}

/**
 * The key of a plain press that may drive the list: `j`, `k`, `u`, `r`... Nothing typed into a
 * field, nothing with a modifier, nothing while the composer is open or an input method is
 * composing. `null` when the press is not the app's.
 */
export function plainKey(press: KeyPress, place: KeyPlace): string | null {
  if (press.isComposing || press.metaKey || press.ctrlKey || press.altKey) return null;
  if (place.composeOpen || place.inSearch || place.textTarget) return null;
  return press.key;
}

/** The ways to write from the thread in the reader: `r`, `a` and `f` (ADR 0020, rule 14; ADR 0045). */
export type WriteKey = "reply" | "replyAll" | "forward";

export function writeKeyOf(key: string): WriteKey | null {
  switch (key) {
    case "r":
      return "reply";
    case "a":
      return "replyAll";
    case "f":
      return "forward";
    default:
      return null;
  }
}

/** What a key does with the thread in the reader (ADR 0044, rule 5). */
export type MoveKey = "archive" | "delete" | "spam" | "pick";

/**
 * `e` archives, `⌫` (or `Delete`, which is what a keyboard without that key has) and `#` delete, `!`
 * marks as spam and `v` opens the Move list. `#` and `!` need Shift, which `plainKey` lets through:
 * it refuses only the modifiers that make a press a command (⌘, Ctrl, Alt). The key is the one
 * the layout produces, so they are where the person's keyboard has them.
 */
export function moveKeyOf(key: string): MoveKey | null {
  switch (key) {
    case "e":
      return "archive";
    case "Backspace":
    case "Delete":
    case "#":
      return "delete";
    case "!":
      return "spam";
    case "v":
      return "pick";
    default:
      return null;
  }
}

/**
 * ⇧⌘A: attach files. Bound inside the composer only. It is a different key from ⌘Z, and attaching
 * never touches the editor's history, so ⌘Z still undoes typing and nothing else (ADR 0020, rule 14).
 */
export function isAttachShortcut(press: {
  readonly key: string;
  readonly isComposing: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}): boolean {
  return (
    !press.isComposing &&
    (press.metaKey || press.ctrlKey) &&
    press.shiftKey &&
    !press.altKey &&
    press.key.toLowerCase() === "a"
  );
}
