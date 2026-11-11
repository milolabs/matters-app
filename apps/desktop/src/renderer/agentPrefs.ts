// Two small things the windows tell each other through this computer's local storage, the way the
// account colours do: whether the person said "Use without AI", and which section of Settings a
// link in the mail window wants to open.

import { parsePaneOpen } from "./paneWidth.ts";

const DECLINED = "matters.ai.declined";
const SECTION = "matters.settings.section";

/** The person chose `Use without AI` on the first-run screen: it is not asked again. */
export function readDeclined(): boolean {
  try {
    return localStorage.getItem(DECLINED) === "1";
  } catch {
    return false;
  }
}

export function writeDeclined(declined: boolean): void {
  try {
    if (declined) localStorage.setItem(DECLINED, "1");
    else localStorage.removeItem(DECLINED);
  } catch {
    // Storage refused: the question may be asked again next time, which is harmless.
  }
}

/** The mail window asks for a section of Settings; the settings window takes it when it looks. */
export function requestSettingsSection(id: string): void {
  try {
    localStorage.setItem(SECTION, id);
  } catch {
    // The settings window then opens on its first section.
  }
}

/** The section that was asked for, once. */
export function takeSettingsSection(): string | null {
  try {
    const id = localStorage.getItem(SECTION);
    if (id !== null) localStorage.removeItem(SECTION);
    return id;
  } catch {
    return null;
  }
}

/** An already open settings window hears a new request. */
export function watchSettingsSection(onAsked: () => void): void {
  window.addEventListener("storage", (event) => {
    if (event.key === SECTION && event.newValue !== null) onAsked();
  });
}

const ENABLED = "matters.ai.enabled";

/**
 * Whether AI was on when this window last heard. It lets the window open on Matters in its first
 * frame instead of after the answer of the backend; the answer then corrects it. It is a hint for
 * the picture only: nothing is sent or started because of it.
 */
export function readEnabledHint(): boolean {
  try {
    return localStorage.getItem(ENABLED) === "1";
  } catch {
    return false;
  }
}

export function writeEnabledHint(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENABLED, "1");
    else localStorage.removeItem(ENABLED);
  } catch {
    // Without storage the tab appears when the backend has answered.
  }
}

const TALK_OPEN = "matters.ai.talkOpen";

/**
 * Whether the person wants the agent's column shown (ADR 0069). It is open unless they hid it:
 * nothing stored, an old value or storage that fails all mean open. It is a preference of this
 * computer. Whether the column is shown in a narrow window is decided elsewhere (`paneShown`).
 */
export function readTalkOpen(): boolean {
  try {
    return parsePaneOpen(localStorage.getItem(TALK_OPEN));
  } catch {
    return true;
  }
}

export function writeTalkOpen(open: boolean): void {
  try {
    localStorage.setItem(TALK_OPEN, open ? "1" : "0");
  } catch {
    // Without storage the column is open again at the next launch.
  }
}

const OPEN_TALK = "matters.ai.openTalk";

/**
 * The talk across all mail that was open (ADR 0086, rule 14): its id, `null` for a new talk, or
 * `undefined` when nothing was ever kept, which opens the latest talk.
 */
export function readOpenTalk(): number | null | undefined {
  try {
    const raw = localStorage.getItem(OPEN_TALK);
    if (raw === null) return undefined;
    if (raw === "new") return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export function writeOpenTalk(id: number | null): void {
  try {
    localStorage.setItem(OPEN_TALK, id === null ? "new" : String(id));
  } catch {
    // Without storage the latest talk opens at the next launch.
  }
}
